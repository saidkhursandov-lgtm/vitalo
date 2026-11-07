import { withDefaultPaymeCodes } from '../payments/payme/payme-config';
/**
 * The single catalog table (VITALO_каталог_единая_таблица.xlsx, sheet «Товары») -> products. npm run import:catalog.
 *
 * - Match by SKU; if not found and «Прежний SKU (если менялся)» is filled, the product with the old SKU is RENAMED
 *   (same id; order_items.sku_snapshot of old orders is not touched). Both found -> error.
 * - New product: every field from the table, status strictly from the table (Виден -> active, Скрыт -> hidden);
 *   no photo does not change the status (a grey tile in the Mini App, only a warning).
 * - Existing product: only EMPTY fields are filled; different non-empty values are shown («база / таблица»).
 *   Flags overwrite: --update-text (texts), --apply-prices (price_uzs, old_price_uzs), --apply-status, --apply-cost.
 * - Dictionaries: missing values are created; case, spaces and quotes «» / "" do not matter.
 * - Photos: the admin panel pipeline (WebP + JPEG, thumbnail), first listed = main for a new product, never twice.
 * - Products in the database but not in the table are only listed. Stock is not used here.
 * - All or nothing: an error in the table -> nothing is written. Running the same file again changes nothing.
 * Plan = read only. Apply = photos are stored first, then ONE database transaction (stored files are removed if it fails).
 */
import { Prisma, ProductStatus } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'crypto';
import ExcelJS from 'exceljs';
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import { cleanName, DICTIONARY_COLUMNS, DICTIONARY_KINDS, DictionaryKind, matchKey } from '../dictionaries/dictionary-names';
import { PrismaService } from '../prisma/prisma.service';
import { dictionaryTable, ensureDictionaryValue } from '../staff/admin-dictionaries';
import { detectImage, MAX_PHOTO_BYTES, ProductInput } from '../staff/admin-products';
import { auditJson, AuditService } from '../staff/audit.service';
import type { FileStorage } from '../storage/file-storage';
import { imageFiles, StoredImage, storeProductImage } from '../storage/image-processing';
import { cellText, normalizeForm, parseNumber } from './yandex-import';

export const CATALOG_SHEET = 'Товары';
const SOURCE = 'import:catalog';

/** Columns by header (lower case, «*» and extra spaces ignored); a header may go on («Фото: имена файлов (через ;…)»). */
const COLUMNS = {
  sku: 'sku',
  old_sku: 'прежний sku',
  status: 'статус в магазине',
  name_ru: 'название (ru)',
  name_uz: 'название (uz)',
  brand: 'бренд',
  manufacturer: 'производитель',
  country: 'страна',
  form: 'форма / дозировка',
  price: 'цена vitalo, сум',
  old_price: 'старая цена vitalo, сум',
  cat_need: 'категории по потребности',
  cat_type: 'категории по типу',
  desc_ru: 'описание (ru)',
  desc_uz: 'описание (uz)',
  composition_ru: 'состав (ru)',
  composition_uz: 'состав (uz)',
  nutrition_ru: 'пищевая ценность и дозировка (ru)',
  nutrition_uz: 'пищевая ценность и дозировка (uz)',
  directions_ru: 'способ применения (ru)',
  directions_uz: 'способ применения (uz)',
  warnings_ru: 'противопоказания и предупреждения (ru)',
  warnings_uz: 'противопоказания и предупреждения (uz)',
  keywords: 'поисковые слова',
  photos: 'фото',
  documents: 'документы',
  weight: 'вес в упаковке, г',
  yandex_price: 'цена на яндексе, сум',
  commission: 'комиссия яндекса, %',
  fee: 'платёжный сбор яндекса, %',
  logistics: 'логистика яндекса, сум',
  cost: 'себестоимость, сум',
  min_stock: 'мин. остаток, шт',
  label_ru: 'короткий состав для этикетки (ru)',
  label_uz: 'короткий состав для этикетки (uz)',
} as const;
type Col = keyof typeof COLUMNS;
const REQUIRED: Col[] = ['sku', 'name_ru', 'brand', 'manufacturer', 'price'];

/** Texts overwritten by --update-text (otherwise only empty ones are filled). */
const TEXTS: [Col, string, string][] = [
  ['name_ru', 'name_ru', 'название RU'],
  ['name_uz', 'name_uz', 'название UZ'],
  ['desc_ru', 'short_description_ru', 'описание RU'],
  ['desc_uz', 'short_description_uz', 'описание UZ'],
  ['composition_ru', 'composition_ru', 'состав RU'],
  ['composition_uz', 'composition_uz', 'состав UZ'],
  ['nutrition_ru', 'nutrition_ru', 'пищевая ценность RU'],
  ['nutrition_uz', 'nutrition_uz', 'пищевая ценность UZ'],
  ['directions_ru', 'directions_ru', 'способ применения RU'],
  ['directions_uz', 'directions_uz', 'способ применения UZ'],
  ['warnings_ru', 'warnings_ru', 'противопоказания RU'],
  ['warnings_uz', 'warnings_uz', 'противопоказания UZ'],
  ['keywords', 'search_keywords', 'поисковые слова'],
  ['label_ru', 'label_composition_ru', 'состав для этикетки RU'],
  ['label_uz', 'label_composition_uz', 'состав для этикетки UZ'],
];
const DICT_COL: Record<DictionaryKind, Col> = { brands: 'brand', manufacturers: 'manufacturer', countries: 'country', forms: 'form' };
const STATUS: Record<string, ProductStatus> = { виден: 'active', скрыт: 'hidden' };
const STATUS_RU: Record<string, string> = { active: 'Виден', hidden: 'Скрыт', archived: 'В архиве' };

/** Words a lawyer should look at (stems), searched in names, descriptions and search words. Nothing is blocked. */
export const LEGAL_WORDS = ['успокоительн', 'лечени', 'профилактик', 'гипотиреоз', 'зоб', 'тестостерон', 'омоложен', 'судорог'];

export interface CatalogFlags {
  updateText: boolean;
  applyPrices: boolean;
  applyStatus: boolean;
  applyCost: boolean;
}
export const NO_FLAGS: CatalogFlags = { updateText: false, applyPrices: false, applyStatus: false, applyCost: false };

export interface CatalogIssue {
  row: number;
  sku?: string;
  message: string;
}

interface PhotoPlan {
  name: string;
  path: string | null;
  attached: boolean; // already on the product (same file name)
}

export interface Diff {
  label: string;
  db: string;
  table: string;
  flag: string | null; // the flag that would apply it
}

export interface CatalogRowPlan {
  row: number;
  sku: string;
  name: string;
  action: 'create' | 'update' | 'unchanged';
  /** existing product, or the id the new one will get */
  productId: string;
  renameFrom: string | null;
  data: Record<string, unknown>;
  link: Partial<Record<DictionaryKind, string>>;
  categoryIds?: string[];
  categoryNames: string[];
  photos: PhotoPlan[];
  /** whether the first new photo becomes the main one */
  firstIsMain: boolean;
  changes: string[];
  diffs: Diff[];
}

export interface CatalogPlan {
  file: string;
  photosDir: string;
  flags: CatalogFlags;
  rows: CatalogRowPlan[];
  errors: CatalogIssue[];
  warnings: CatalogIssue[];
  /** in the database, not in the table: only listed */
  notInTable: { sku: string; name: string; status: string }[];
  newValues: Partial<Record<DictionaryKind, string[]>>;
  legal: { sku: string; field: string; word: string; fragment: string }[];
}

export interface CatalogResult {
  created: string[];
  updated: string[];
  renamed: string[];
  unchanged: string[];
  photos: number;
  dictionaryValues: string[];
}

// ---------------------------------------------------------------- helpers

const headerKey = (s: string) => s.replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const headerMatches = (h: string, key: string) => h === key || h.startsWith(`${key} `) || h.startsWith(`${key}(`) || h.startsWith(`${key}:`) || h.startsWith(`${key},`);
/** Dictionary key: case, spaces, ё/е and the kind of quotes do not matter («ЗОЖ» = "ЗОЖ"). */
export const dictKey = (s: string) => matchKey(s).replace(/[«»„“”"'`‘’]/g, '"');
const sameText = (a: unknown, b: unknown) => String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim();
const isEmpty = (v: unknown) => v == null || (typeof v === 'string' && !v.trim());
const short = (v: unknown) => {
  const s = String(v ?? '—').replace(/\n/g, ' ');
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
};
const splitList = (t: string) => t.split(';').map((s) => s.trim()).filter(Boolean);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е');

// ---------------------------------------------------------------- planning (read only)

export async function planCatalogImport(prisma: PrismaService, opts: { file: string; photosDir: string; flags?: CatalogFlags }): Promise<CatalogPlan> {
  const flags = opts.flags ?? NO_FLAGS;
  const plan: CatalogPlan = { file: opts.file, photosDir: opts.photosDir, flags, rows: [], errors: [], warnings: [], notInTable: [], newValues: {}, legal: [] };
  const error = (row: number, message: string, sku?: string) => plan.errors.push({ row, sku, message });
  const warn = (row: number, message: string, sku?: string) => plan.warnings.push({ row, sku, message });

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(opts.file);
  } catch (e) {
    error(0, `Не удалось открыть файл ${opts.file}: ${(e as Error).message}`);
    return plan;
  }
  const ws = wb.worksheets.find((w) => headerKey(w.name) === headerKey(CATALOG_SHEET));
  if (!ws) {
    error(0, `В файле нет листа «${CATALOG_SHEET}»`);
    return plan;
  }
  const col: Partial<Record<Col, number>> = {};
  ws.getRow(1).eachCell((cell, i) => {
    const h = headerKey(cellText(cell.value));
    if (h.startsWith('примечание')) return; // «Примечание (не загружается)»
    // the longest matching key wins («цена vitalo» vs «старая цена vitalo» are different starts anyway)
    const key = (Object.keys(COLUMNS) as Col[]).filter((k) => headerMatches(h, COLUMNS[k])).sort((a, b) => COLUMNS[b].length - COLUMNS[a].length)[0];
    if (key && col[key] === undefined) col[key] = i;
  });
  const missing = REQUIRED.filter((k) => !col[k]);
  if (missing.length) {
    error(0, `Нет обязательных колонок: ${missing.map((k) => COLUMNS[k]).join(', ')}`);
    return plan;
  }

  // Reference data
  const products = await prisma.products.findMany({ include: { categories: { include: { category: true } }, media: true } });
  const bySku = new Map(products.map((p) => [p.sku, p]));
  const categories = await prisma.categories.findMany({ where: { status: 'active' }, include: { parent: true } });
  const dict: Record<DictionaryKind, Map<string, string>> = { brands: new Map(), manufacturers: new Map(), countries: new Map(), forms: new Map() };
  for (const kind of DICTIONARY_KINDS) for (const r of await dictionaryTable(prisma, kind).findMany()) dict[kind].set(dictKey(r.name_ru), r.name_ru);
  let photoFiles: string[] = [];
  try {
    photoFiles = await readdir(opts.photosDir);
  } catch {
    warn(0, `Папка с фото не найдена: ${opts.photosDir} — фото не будут загружены`);
  }
  const fileByLower = new Map(photoFiles.map((f) => [f.toLowerCase(), f]));
  const seenSku = new Map<string, number>();
  const seenOld = new Map<string, number>();
  const matchedIds = new Set<string>();

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const raw = (k: Col) => (col[k] ? row.getCell(col[k]!).value : null);
    const get = (k: Col) => cellText(raw(k));
    if (!(Object.keys(col) as Col[]).some((k) => get(k))) continue; // empty row

    const sku = get('sku');
    const before = plan.errors.length;
    for (const k of REQUIRED) if (!get(k)) error(r, `пустое обязательное поле «${COLUMNS[k]}»`, sku || undefined);
    if (!sku) continue;
    if (seenSku.has(sku.toLowerCase())) {
      error(r, `SKU повторяется в таблице (уже был в строке ${seenSku.get(sku.toLowerCase())})`, sku);
      continue;
    }
    seenSku.set(sku.toLowerCase(), r);

    // ---- matching (SKU, then the old SKU = rename)
    const oldSku = get('old_sku');
    let existing = bySku.get(sku) ?? null;
    let renameFrom: string | null = null;
    if (oldSku && oldSku !== sku) {
      if (seenOld.has(oldSku.toLowerCase())) error(r, `прежний SKU ${oldSku} уже указан в строке ${seenOld.get(oldSku.toLowerCase())}`, sku);
      seenOld.set(oldSku.toLowerCase(), r);
      const old = bySku.get(oldSku);
      if (old && existing) error(r, `в базе есть и ${sku}, и прежний ${oldSku} — непонятно, какой товар обновлять`, sku);
      else if (old && !existing) {
        existing = old;
        renameFrom = oldSku;
      }
    }
    if (existing && matchedIds.has(existing.id)) error(r, `товар ${existing.sku} уже сопоставлен с другой строкой таблицы`, sku);
    if (existing) matchedIds.add(existing.id);

    // ---- numbers
    const money = (k: Col) => {
      if (!col[k]) return null;
      const v = parseNumber(raw(k));
      if (v === 'bad' || (typeof v === 'number' && (v < 0 || !Number.isInteger(v)))) {
        error(r, `«${COLUMNS[k]}»: нужно целое число (сум / шт / г), сейчас «${get(k)}»`, sku);
        return null;
      }
      return v;
    };
    const percent = (k: Col) => {
      if (!col[k]) return null;
      const v = parseNumber(raw(k));
      if (v === 'bad' || (typeof v === 'number' && (v < 0 || v > 100 || Math.abs(Math.round(v * 100) - v * 100) > 1e-6))) {
        error(r, `«${COLUMNS[k]}»: нужен процент от 0 до 100 (до двух знаков после запятой), сейчас «${get(k)}»`, sku);
        return null;
      }
      return v;
    };
    const num = {
      price: money('price'),
      old_price: money('old_price'),
      cost: money('cost'),
      weight: money('weight'),
      min_stock: money('min_stock'),
      yandex_price: money('yandex_price'),
      logistics: money('logistics'),
      commission: percent('commission'),
      fee: percent('fee'),
    };

    // ---- status
    let status: ProductStatus | null = null;
    if (get('status')) {
      status = STATUS[norm(get('status'))] ?? null;
      if (!status) error(r, `«Статус в магазине»: «${get('status')}» — нужно «Виден» или «Скрыт»`, sku);
    } else if (!existing) error(r, 'новый товар: пустой «Статус в магазине» (Виден / Скрыт)', sku);

    // ---- dictionary values (existing spelling wins when only quotes / case / spaces differ)
    const values: Partial<Record<DictionaryKind, string>> = {};
    for (const kind of DICTIONARY_KINDS) {
      const text = get(DICT_COL[kind]);
      if (!text) continue;
      let name = cleanName(text);
      if (kind === 'forms') {
        const f = normalizeForm(text);
        if ('error' in f) {
          error(r, f.error, sku);
          continue;
        }
        if (f.note) warn(r, f.note, sku);
        name = f.form;
      }
      const known = dict[kind].get(dictKey(name));
      if (known) name = known;
      else {
        dict[kind].set(dictKey(name), name);
        (plan.newValues[kind] ??= []).push(name);
      }
      values[kind] = name;
    }

    // ---- categories (both trees; «Красота → Кожа» or «Кожа»; unknown -> skipped with a warning)
    const tableCats: Record<'need' | 'product_type', { ids: string[]; names: string[] } | null> = { need: null, product_type: null };
    for (const [c, tree] of [['cat_need', 'need'], ['cat_type', 'product_type']] as const) {
      if (!get(c)) continue;
      const found = { ids: [] as string[], names: [] as string[] };
      for (const name of splitList(get(c))) {
        const parts = name.split(/→|->|>/).map((s) => norm(s));
        const leaf = parts[parts.length - 1];
        let hits = categories.filter((k) => k.tree_type === tree && (norm(k.name_ru) === leaf || norm(k.name_uz) === leaf));
        if (hits.length > 1 && parts.length > 1) hits = hits.filter((k) => k.parent && norm(k.parent.name_ru) === parts[parts.length - 2]);
        if (hits.length === 1) {
          if (!found.ids.includes(hits[0].id)) {
            found.ids.push(hits[0].id);
            found.names.push(hits[0].parent ? `${hits[0].parent.name_ru} → ${hits[0].name_ru}` : hits[0].name_ru);
          }
        } else warn(r, `категория «${name}» (${tree === 'need' ? 'по потребности' : 'по типу'}) ${hits.length ? 'неоднозначна' : 'не найдена'} — пропущена`, sku);
      }
      tableCats[tree] = found;
    }

    if (get('documents')) warn(r, `«Документы» (${get('documents')}) не загружаются этим импортом — пропущены`, sku);

    // ---- legal wording
    for (const [c, label] of [['name_ru', 'название RU'], ['name_uz', 'название UZ'], ['desc_ru', 'описание RU'], ['desc_uz', 'описание UZ'], ['keywords', 'поисковые слова']] as const) {
      const text = get(c);
      const lower = text.toLowerCase();
      for (const word of LEGAL_WORDS) {
        const at = lower.indexOf(word);
        if (at >= 0) plan.legal.push({ sku, field: label, word, fragment: text.slice(Math.max(0, at - 25), at + word.length + 25).replace(/\n/g, ' ') });
      }
    }

    // ---- photos
    const photos: PhotoPlan[] = [];
    for (const name of splitList(get('photos'))) {
      const file = fileByLower.get(name.toLowerCase());
      const attached = !!existing?.media.some((m) => m.title?.toLowerCase() === name.toLowerCase());
      if (!file) {
        if (!attached) warn(r, `фото «${name}» не найдено в папке ${opts.photosDir}`, sku);
        photos.push({ name, path: null, attached });
        continue;
      }
      const path = join(opts.photosDir, file);
      const problem = await checkPhoto(path);
      if (problem) {
        warn(r, `фото «${name}»: ${problem} — пропущено`, sku);
        photos.push({ name, path: null, attached });
        continue;
      }
      photos.push({ name, path, attached });
    }
    const hasPhoto = photos.some((p) => p.path || p.attached) || !!existing?.media.some((m) => m.media_type === 'image');
    if (!hasPhoto) warn(r, (status ?? existing?.status) === 'hidden' ? 'нет фото (товар скрыт); статус не меняется' : 'нет фото — товар будет виден с серой плиткой; статус не меняется', sku);

    // ---- what to write
    const data: Record<string, unknown> = {};
    const link: Partial<Record<DictionaryKind, string>> = {};
    const changes: string[] = [];
    const diffs: Diff[] = [];
    let categoryIds: string[] | undefined;
    const categoryNames: string[] = [];

    if (!existing) {
      Object.assign(data, {
        sku,
        status,
        price_uzs: num.price,
        old_price_uzs: num.old_price,
        cost_uzs: num.cost,
        min_stock: num.min_stock ?? 0,
        shipping_weight_g: num.weight,
        yandex_price_uzs: num.yandex_price,
        yandex_commission_percent: num.commission,
        yandex_payment_fee_percent: num.fee,
        yandex_logistics_uzs: num.logistics,
      });
      for (const [c, field] of TEXTS) data[field] = get(c) || null;
      for (const kind of DICTIONARY_KINDS) {
        data[DICTIONARY_COLUMNS[kind].text] = values[kind] ?? null;
        if (values[kind]) link[kind] = values[kind];
      }
      categoryIds = [...(tableCats.need?.ids ?? []), ...(tableCats.product_type?.ids ?? [])];
      categoryNames.push(...(tableCats.need?.names ?? []), ...(tableCats.product_type?.names ?? []));
      if (!get('name_uz')) warn(r, 'новый товар без названия на узбекском — покажется русское', sku);
      if (num.cost == null) warn(r, 'новый товар без себестоимости — начальный остаток по нему не загрузится', sku);
    } else {
      const consider = (field: string, label: string, dbValue: unknown, tableValue: unknown, opt: { overwrite?: boolean; flag?: string | null; fillEmpty?: boolean; empty?: (v: unknown) => boolean; same?: (a: unknown, b: unknown) => boolean } = {}) => {
        if (isEmpty(tableValue)) return; // an empty cell never erases
        const empty = opt.empty ?? isEmpty;
        const same = opt.same ?? ((a: unknown, b: unknown) => (typeof b === 'number' ? Number(a) === b : sameText(a, b)));
        if (empty(dbValue) && opt.fillEmpty !== false) {
          data[field] = tableValue;
          changes.push(`${label}: заполнено (${short(tableValue)})`);
        } else if (!same(dbValue, tableValue)) {
          if (opt.overwrite) {
            data[field] = tableValue;
            changes.push(`${label}: ${short(dbValue)} → ${short(tableValue)}`);
          } else diffs.push({ label, db: short(empty(dbValue) ? '—' : dbValue), table: short(tableValue), flag: opt.flag ?? null });
        }
      };
      const e = existing as unknown as Record<string, unknown>;
      for (const [c, field, label] of TEXTS) consider(field, label, e[field], get(c) || null, { overwrite: flags.updateText, flag: '--update-text' });
      consider('price_uzs', 'цена VITALO', existing.price_uzs, num.price, { overwrite: flags.applyPrices, flag: '--apply-prices' });
      consider('old_price_uzs', 'старая цена', existing.old_price_uzs, num.old_price, { overwrite: flags.applyPrices, flag: '--apply-prices' });
      consider('cost_uzs', 'себестоимость', existing.cost_uzs, num.cost, { overwrite: flags.applyCost, fillEmpty: flags.applyCost, flag: '--apply-cost' });
      if (status) consider('status', 'статус', existing.status, status, { overwrite: flags.applyStatus, flag: '--apply-status', same: (a, b) => a === b });
      consider('shipping_weight_g', 'вес, г', existing.shipping_weight_g, num.weight);
      consider('min_stock', 'мин. остаток', existing.min_stock, num.min_stock, { empty: (v) => v == null || v === 0 });
      consider('yandex_price_uzs', 'цена Яндекса', existing.yandex_price_uzs, num.yandex_price);
      consider('yandex_commission_percent', 'комиссия Яндекса, %', existing.yandex_commission_percent, num.commission);
      consider('yandex_payment_fee_percent', 'платёжный сбор Яндекса, %', existing.yandex_payment_fee_percent, num.fee);
      consider('yandex_logistics_uzs', 'логистика Яндекса', existing.yandex_logistics_uzs, num.logistics);
      // Dictionaries: an empty field is filled; the same value (case / spaces / quotes) gets linked; otherwise a difference.
      for (const kind of DICTIONARY_KINDS) {
        const value = values[kind];
        if (!value) continue;
        const cols = DICTIONARY_COLUMNS[kind];
        const text = e[cols.text] as string | null;
        if (isEmpty(text)) {
          link[kind] = value;
          changes.push(`${cols.label}: заполнено (${value})`);
        } else if (dictKey(text!) === dictKey(value)) {
          if (!e[cols.id] || text !== value) {
            link[kind] = value;
            changes.push(`${cols.label}: привязать к справочнику «${value}»`);
          }
        } else diffs.push({ label: cols.label, db: short(text), table: short(value), flag: null });
      }
      // Categories per tree: filled when the product has none in that tree; otherwise a difference.
      const now = existing.categories;
      let changed = false;
      const ids: string[] = [];
      for (const tree of ['need', 'product_type'] as const) {
        const mine = now.filter((pc) => pc.category.tree_type === tree);
        const t = tableCats[tree];
        if (t && t.ids.length && !mine.length) {
          ids.push(...t.ids);
          categoryNames.push(...t.names);
          changed = true;
          changes.push(`категории (${tree === 'need' ? 'по потребности' : 'по типу'}): заполнено (${t.names.join(', ')})`);
        } else {
          ids.push(...mine.map((pc) => pc.category_id));
          if (t && t.ids.length && [...t.ids].sort().join() !== mine.map((pc) => pc.category_id).sort().join()) {
            diffs.push({ label: `категории (${tree === 'need' ? 'потребность' : 'тип'})`, db: mine.map((pc) => pc.category.name_ru).join(', '), table: t.names.join(', '), flag: null });
          }
        }
      }
      if (changed) categoryIds = ids;
      if (renameFrom) changes.unshift(`переименовать ${renameFrom} → ${sku}`);
    }
    if (data.yandex_price_uzs != null) {
      // The table carries the Yandex Market data itself: the price there is synchronized by definition.
      data.yandex_price_sync_needed = false;
      data.yandex_price_sync_changed_at = new Date();
    }

    // Same rules as the admin panel (SKU format, lengths, percents)
    const merged: Record<string, unknown> = { name_ru: 'x', brand: 'x', manufacturer: 'x', price_uzs: 0, ...data, sku };
    for (const kind of DICTIONARY_KINDS) if (values[kind]) merged[DICTIONARY_COLUMNS[kind].text] = values[kind];
    const check = plainToInstance(ProductInput, merged);
    for (const p of await validate(check, { forbidUnknownValues: false })) {
      if (merged[p.property] !== undefined && merged[p.property] !== null) error(r, `поле ${p.property}: ${Object.values(p.constraints ?? {}).join('; ')}`, sku);
    }
    for (const field of ['label_composition_ru', 'label_composition_uz']) {
      const v = data[field] as string | null | undefined;
      if (v && v.length > 300) error(r, `${field}: не длиннее 300 символов (сейчас ${v.length})`, sku);
    }

    if (plan.errors.length > before) continue;
    const newPhotos = photos.filter((p) => p.path && !p.attached);
    if (newPhotos.length) changes.push(`фото +${newPhotos.length}`);
    plan.rows.push({
      row: r,
      sku,
      name: get('name_ru') || existing?.name_ru || sku,
      action: !existing ? 'create' : changes.length || renameFrom ? 'update' : 'unchanged',
      productId: existing?.id ?? randomUUID(),
      renameFrom,
      data,
      link,
      categoryIds,
      categoryNames,
      photos,
      firstIsMain: !existing || !existing.media.some((m) => m.is_main && m.media_type === 'image'),
      changes,
      diffs,
    });
  }

  for (const p of products) if (!matchedIds.has(p.id) && p.status !== 'archived') plan.notInTable.push({ sku: p.sku, name: p.name_ru, status: STATUS_RU[p.status] ?? p.status });
  if (!plan.rows.length && !plan.errors.length) warn(0, 'В таблице нет товаров');
  return plan;
}

/** A photo the admin pipeline can take: JPEG / PNG / WebP, not too big, readable. Returns the problem or null. */
async function checkPhoto(path: string): Promise<string | null> {
  const size = (await stat(path)).size;
  if (size > MAX_PHOTO_BYTES) return `больше ${MAX_PHOTO_BYTES / 1024 / 1024} МБ`;
  const buf = await readFile(path);
  if (!detectImage(buf)) return 'не JPEG / PNG / WebP';
  try {
    await sharp(buf).metadata();
    return null;
  } catch {
    return 'файл не читается как картинка';
  }
}

// ---------------------------------------------------------------- applying

/** DB types: sums are BigInt, percents Decimal. */
function toDb(data: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...data };
  for (const k of ['price_uzs', 'old_price_uzs', 'cost_uzs', 'yandex_price_uzs', 'yandex_logistics_uzs']) if (typeof out[k] === 'number') out[k] = BigInt(out[k] as number);
  for (const k of ['yandex_commission_percent', 'yandex_payment_fee_percent']) if (typeof out[k] === 'number') out[k] = new Prisma.Decimal(out[k] as number);
  return out;
}

export async function applyCatalogImport(prisma: PrismaService, audit: AuditService, storage: FileStorage, plan: CatalogPlan): Promise<CatalogResult> {
  if (plan.errors.length) throw new Error('В таблице есть ошибки — ничего не записано. Исправьте их и запустите проверку ещё раз.');
  const result: CatalogResult = { created: [], updated: [], renamed: [], unchanged: [], photos: 0, dictionaryValues: [] };

  // 1. Photos first (files only): the same pipeline as «Добавить фото» in the admin panel.
  const stored = new Map<string, { name: string; img: StoredImage }[]>();
  try {
    for (const p of plan.rows) {
      for (const ph of p.photos.filter((x) => x.path && !x.attached)) {
        const img = await storeProductImage(storage, p.productId, await readFile(ph.path!));
        stored.set(p.productId, [...(stored.get(p.productId) ?? []), { name: ph.name, img }]);
      }
    }

    // 2. Everything in the database: one transaction.
    await prisma.$transaction(
      async (tx) => {
        for (const p of plan.rows) {
          if (p.action === 'unchanged') {
            result.unchanged.push(p.sku);
            continue;
          }
          const data = toDb(p.data);
          for (const kind of Object.keys(p.link) as DictionaryKind[]) {
            const { row, created } = await ensureDictionaryValue(tx, audit, kind, p.link[kind]!, null);
            if (created) result.dictionaryValues.push(`${DICTIONARY_COLUMNS[kind].label}: ${row.name_ru}`);
            data[DICTIONARY_COLUMNS[kind].id] = row.id;
            data[DICTIONARY_COLUMNS[kind].text] = row.name_ru; // the Mini App reads the text
          }
          if (p.action === 'create') {
            const created = await tx.products.create({ data: { ...(withDefaultPaymeCodes(data) as Prisma.productsUncheckedCreateInput), id: p.productId } });
            if (p.categoryIds?.length) await tx.product_categories.createMany({ data: p.categoryIds.map((c) => ({ product_id: created.id, category_id: c })) });
            await audit.log({ staffId: null, action: 'product.created', entityType: 'product', entityId: created.id, after: { ...(auditJson(created) as object), category_ids: p.categoryIds, source: SOURCE } }, tx);
            result.created.push(p.sku);
          } else {
            const before = await tx.products.findUniqueOrThrow({ where: { id: p.productId } });
            if (p.renameFrom) {
              if (await tx.products.findUnique({ where: { sku: p.sku } })) throw new Error(`SKU ${p.sku} уже занят — переименование ${p.renameFrom} невозможно. Ничего не записано.`);
              await tx.products.update({ where: { id: p.productId }, data: { sku: p.sku } });
              await audit.log({ staffId: null, action: 'product.sku_renamed', entityType: 'product', entityId: p.productId, before: { sku: p.renameFrom }, after: { sku: p.sku, source: SOURCE } }, tx);
              result.renamed.push(`${p.renameFrom} → ${p.sku}`);
            }
            const changed = Object.keys(data);
            if (changed.length) {
              const after = await tx.products.update({ where: { id: p.productId }, data: data as Prisma.productsUncheckedUpdateInput });
              const pick = (o: Record<string, unknown>) => Object.fromEntries(changed.map((k) => [k, o[k]]));
              await audit.log({ staffId: null, action: 'product.updated', entityType: 'product', entityId: p.productId, before: pick(before), after: { ...pick(after), source: SOURCE } }, tx);
            }
            if (p.categoryIds) {
              await tx.product_categories.deleteMany({ where: { product_id: p.productId } });
              await tx.product_categories.createMany({ data: p.categoryIds.map((c) => ({ product_id: p.productId, category_id: c })) });
            }
            result.updated.push(p.sku);
          }
          const imgs = stored.get(p.productId) ?? [];
          if (imgs.length) {
            const media = await tx.product_media.findMany({ where: { product_id: p.productId } });
            let order = media.reduce((m, x) => Math.max(m, x.sort_order), -1);
            for (const [i, { name, img }] of imgs.entries()) {
              const main = i === 0 && p.firstIsMain;
              if (main) await tx.product_media.updateMany({ where: { product_id: p.productId }, data: { is_main: false } });
              const m = await tx.product_media.create({ data: { product_id: p.productId, media_type: 'image', ...img, is_main: main, title: name, sort_order: ++order } });
              await audit.log({ staffId: null, action: 'product.photo_added', entityType: 'product', entityId: p.productId, after: { media_id: m.id, url: m.url, file: name, main, source: SOURCE } }, tx);
              result.photos++;
            }
          }
        }
      },
      { maxWait: 10_000, timeout: 180_000 },
    );
  } catch (e) {
    // Nothing reached the database: the stored photo files are removed too.
    for (const list of stored.values()) for (const { img } of list) for (const url of imageFiles(img)) await storage.remove(url).catch(() => undefined);
    throw e;
  }
  return result;
}

// ---------------------------------------------------------------- report

const KIND_LABEL: Record<DictionaryKind, string> = { brands: 'бренды', manufacturers: 'производители', countries: 'страны', forms: 'формы' };

export function formatCatalogPlan(plan: CatalogPlan): string {
  const out: string[] = [];
  const on = Object.entries(plan.flags).filter(([, v]) => v).map(([k]) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  out.push(`Флаги: ${on.length ? on.join(' ') : 'нет (у существующих товаров заполняются только пустые поля)'}`, '');
  const label = { create: 'СОЗДАТЬ', update: 'ОБНОВИТЬ', unchanged: 'без изменений' };
  for (const p of plan.rows) {
    out.push(`[строка ${p.row}] ${p.sku} — ${short(p.name)}: ${label[p.action]}${p.renameFrom ? ` (переименовать ${p.renameFrom} → ${p.sku})` : ''}`);
    if (p.action === 'create') {
      const d = p.data;
      out.push(`    статус ${STATUS_RU[d.status as string]}, цена ${d.price_uzs}${d.old_price_uzs != null ? `, старая ${d.old_price_uzs}` : ''}, себестоимость ${d.cost_uzs ?? '—'}`);
      out.push(`    категории: ${p.categoryNames.join(', ') || '—'}`);
    } else for (const c of p.changes) out.push(`    ${c}`);
    if (p.photos.length) out.push(`    фото: ${p.photos.map((x, i) => `${x.name}${i === 0 && p.firstIsMain ? ' (главное)' : ''}${x.attached ? ' — уже есть' : !x.path ? ' — НЕ НАЙДЕНО' : ''}`).join('; ')}`);
    if (p.diffs.length) {
      out.push('    различия (не применяются)        | база                         | таблица');
      for (const d of p.diffs) out.push(`      ${d.label.padEnd(30)} | ${d.db.padEnd(28)} | ${d.table}${d.flag ? `   [${d.flag}]` : ''}`);
    }
  }
  const values = Object.entries(plan.newValues).filter(([, v]) => v?.length);
  if (values.length) {
    out.push('', 'Новые значения справочников:');
    for (const [k, v] of values) out.push(`  ${KIND_LABEL[k as DictionaryKind]}: ${v!.join(', ')}`);
  }
  if (plan.notInTable.length) {
    out.push('', `В базе, но нет в таблице — НЕ трогаю (${plan.notInTable.length}):`);
    for (const p of plan.notInTable) out.push(`  ${p.sku} — ${short(p.name)} (${p.status})`);
  }
  if (plan.legal.length) {
    out.push('', `Формулировки для юриста (ничего не заблокировано) — ${plan.legal.length}:`);
    for (const l of plan.legal) out.push(`  ${l.sku}, ${l.field}: «${l.word}…» — …${l.fragment}…`);
  }
  const list = (title: string, items: CatalogIssue[]) => {
    if (!items.length) return;
    out.push('', `${title} (${items.length}):`);
    for (const i of items) out.push(`  - ${i.row ? `строка ${i.row}` : 'файл'}${i.sku ? `, ${i.sku}` : ''}: ${i.message}`);
  };
  list('ОШИБКИ — запись невозможна, пока их не исправить', plan.errors);
  list('Предупреждения', plan.warnings);
  const n = (a: CatalogRowPlan['action']) => plan.rows.filter((r) => r.action === a).length;
  const renames = plan.rows.filter((r) => r.renameFrom).length;
  const diffs = plan.rows.reduce((s, r) => s + r.diffs.length, 0);
  out.push('', `Итого: создать ${n('create')}, обновить ${n('update')} (из них переименовать ${renames}), без изменений ${n('unchanged')}; различий не применено ${diffs}; ошибок ${plan.errors.length}, предупреждений ${plan.warnings.length}.`);
  return out.join('\n');
}

export function formatCatalogResult(r: CatalogResult): string {
  return [
    `Создано: ${r.created.length}${r.created.length ? ` (${r.created.join(', ')})` : ''}`,
    `Обновлено: ${r.updated.length}${r.updated.length ? ` (${r.updated.join(', ')})` : ''}`,
    `Переименовано: ${r.renamed.length ? r.renamed.join(', ') : 'нет'}`,
    `Без изменений: ${r.unchanged.length}`,
    `Фото добавлено: ${r.photos}`,
    `Новые значения справочников: ${r.dictionaryValues.length ? r.dictionaryValues.join('; ') : 'нет'}`,
  ].join('\n');
}
