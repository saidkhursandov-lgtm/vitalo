/**
 * Stage 1.5: Yandex Market table (VITALO_Yandex_данные_v4.xlsx, sheet «Яндекс Маркет»).
 *
 * - Columns are found by their header text; other sheets are ignored.
 * - Existing product (by «Наш текущий SKU»): Yandex price / commission / payment fee / logistics are set,
 *   dictionaries linked, ONLY empty text fields filled; non-empty ones stay and differences are reported.
 *   The VITALO price from the table is never applied (only the difference is shown).
 * - Unknown SKU: a new product with status hidden (admin only, not in the Mini App), no categories,
 *   photos or stock.
 * - All or nothing: any error in the table -> nothing is written. Running the same file again changes nothing.
 * - Plan = read only. Apply = one database transaction.
 */
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import ExcelJS from 'exceljs';
import { cleanName, DICTIONARY_COLUMNS, DictionaryKind, matchKey } from '../dictionaries/dictionary-names';
import { PrismaService } from '../prisma/prisma.service';
import { dictionaryTable, ensureDictionaryValue } from '../staff/admin-dictionaries';
import { ProductInput } from '../staff/admin-products';
import { auditJson, AuditService } from '../staff/audit.service';

export const YANDEX_SHEET = 'Яндекс Маркет';
/** «Таблетки; Капсулы» in the table = this form. */
export const TABLETS_AND_CAPSULES = 'Капсулы и таблетки (набор)';

const COLUMNS = {
  sku: 'наш текущий sku',
  yandex_sku: 'sku яндекса',
  name: 'название товара (для сверки)',
  brand: 'бренд',
  name_uz: 'название на узбекском',
  price: 'цена vitalo, сум',
  old_price: 'старая цена vitalo (для акции)',
  yandex_price: 'цена на яндексе, сум',
  desc_ru: 'описание рус',
  desc_uz: 'описание узб',
  manufacturer: 'производитель',
  country: 'страна производителя',
  form: 'форма',
  composition: 'состав',
  nutrition: 'пищевая ценность и дозировка',
  directions: 'способ применения',
  warnings: 'противопоказания и предупреждения',
  commission: 'комиссия яндекса, %',
  fee: 'поручение на перевод платежа (яндекс), %',
  logistics: 'логистика яндекса, сум (фикс.)',
} as const;
type Column = keyof typeof COLUMNS;
const REQUIRED_COLUMNS: Column[] = ['sku', 'yandex_sku', 'brand', 'yandex_price', 'commission', 'logistics'];

/** Product text fields filled from the table only while they are empty. */
const FILL_TEXT: [Column, 'name_uz' | 'short_description_ru' | 'short_description_uz' | 'composition_ru' | 'nutrition_ru' | 'directions_ru' | 'warnings_ru'][] = [
  ['name_uz', 'name_uz'],
  ['desc_ru', 'short_description_ru'],
  ['desc_uz', 'short_description_uz'],
  ['composition', 'composition_ru'],
  ['nutrition', 'nutrition_ru'],
  ['directions', 'directions_ru'],
  ['warnings', 'warnings_ru'],
];
const DICT_COLUMN: Record<DictionaryKind, Column> = { brands: 'brand', manufacturers: 'manufacturer', countries: 'country', forms: 'form' };

export interface YandexIssue {
  row: number;
  sku?: string;
  message: string;
}

export interface YandexRowPlan {
  row: number;
  sku: string;
  action: 'create' | 'update' | 'unchanged';
  productId: string | null;
  name: string;
  /** product columns to write (text, prices, Yandex fields) */
  data: Record<string, unknown>;
  /** dictionary values to link: kind -> name (created when missing) */
  link: Partial<Record<DictionaryKind, string>>;
  changes: string[];
  notes: string[]; // differences that are NOT applied
}

export interface YandexPlan {
  rows: YandexRowPlan[];
  newValues: Partial<Record<DictionaryKind, string[]>>;
  errors: YandexIssue[];
  warnings: YandexIssue[];
}

export interface YandexResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  dictionaryValues: string[];
}

// ---------------------------------------------------------------- reading cells

const headerKey = (s: string) => s.replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Text of a cell: rich text / formulas included; literal «\n» and Windows line breaks become real ones. */
function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  let s: string;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'object' && 'richText' in v) s = v.richText.map((r) => r.text).join('');
  else if (typeof v === 'object' && 'result' in v) return cellText(v.result as ExcelJS.CellValue);
  else if (typeof v === 'object' && 'text' in v) return cellText(v.text as ExcelJS.CellValue);
  else s = String(v);
  return s.replace(/\\r\\n|\\n/g, '\n').replace(/\r\n?/g, '\n').trim();
}

/** Number written as 18.5, «18,5», «5 000» or text «0.5». null = empty cell, 'bad' = not a number. */
export function parseNumber(v: ExcelJS.CellValue): number | null | 'bad' {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 'bad';
  const t = cellText(v).replace(/[\s  ]/g, '').replace(',', '.');
  if (!t) return null;
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : 'bad';
}

const sameText = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').replace(/\s+/g, ' ').trim() === (b ?? '').replace(/\s+/g, ' ').trim();
const short = (s: string) => (s.length > 40 ? `${s.slice(0, 40).replace(/\n/g, ' ')}…` : s.replace(/\n/g, ' '));

/** «Таблетки; Капсулы» -> the set form; any other list of forms is an error. */
function normalizeForm(text: string): { form: string; note?: string } | { error: string } {
  if (!text.includes(';')) return { form: cleanName(text) };
  const parts = text.split(';').map((s) => matchKey(s)).filter(Boolean).sort();
  if (parts.join('|') === 'капсулы|таблетки') return { form: TABLETS_AND_CAPSULES, note: `форма «${text}» → «${TABLETS_AND_CAPSULES}»` };
  return { error: `в «Форма» несколько значений («${text}») — укажите одно` };
}

// ---------------------------------------------------------------- planning (read only)

export async function planYandexImport(prisma: PrismaService, file: string): Promise<YandexPlan> {
  const plan: YandexPlan = { rows: [], newValues: {}, errors: [], warnings: [] };
  const error = (row: number, message: string, sku?: string) => plan.errors.push({ row, sku, message });
  const warn = (row: number, message: string, sku?: string) => plan.warnings.push({ row, sku, message });

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(file);
  } catch (e) {
    error(0, `Не удалось открыть файл ${file}: ${(e as Error).message}`);
    return plan;
  }
  const ws = wb.worksheets.find((w) => headerKey(w.name) === headerKey(YANDEX_SHEET));
  if (!ws) {
    error(0, `В файле нет листа «${YANDEX_SHEET}»`);
    return plan;
  }
  const col: Partial<Record<Column, number>> = {};
  ws.getRow(1).eachCell((cell, i) => {
    const key = (Object.keys(COLUMNS) as Column[]).find((k) => COLUMNS[k] === headerKey(cellText(cell.value)));
    if (key) col[key] = i;
  });
  const missing = REQUIRED_COLUMNS.filter((k) => !col[k]);
  if (missing.length) {
    error(0, `Нет обязательных колонок: ${missing.map((k) => COLUMNS[k]).join(', ')}`);
    return plan;
  }

  const known: Record<DictionaryKind, Set<string>> = { brands: new Set(), manufacturers: new Set(), countries: new Set(), forms: new Set() };
  for (const kind of Object.keys(known) as DictionaryKind[]) for (const r of await dictionaryTable(prisma, kind).findMany()) known[kind].add(matchKey(r.name_ru));
  const seen = new Map<string, number>();

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const raw = (k: Column) => (col[k] ? row.getCell(col[k]!).value : null);
    const get = (k: Column) => cellText(raw(k));
    if (!(Object.keys(col) as Column[]).some((k) => get(k))) continue; // empty row

    const sku = get('sku');
    const before = plan.errors.length;
    for (const k of REQUIRED_COLUMNS) if (!get(k)) error(r, `пустое обязательное поле «${COLUMNS[k]}»`, sku || undefined);
    if (!sku) continue;
    if (seen.has(sku.toLowerCase())) {
      error(r, `SKU повторяется (уже был в строке ${seen.get(sku.toLowerCase())})`, sku);
      continue;
    }
    seen.set(sku.toLowerCase(), r);
    if (get('yandex_sku') && get('yandex_sku') !== sku) warn(r, `SKU Яндекса «${get('yandex_sku')}» отличается от нашего — ничего не переименовано`, sku);

    // Numbers
    const money = (k: Column) => {
      const v = parseNumber(raw(k));
      if (v === 'bad' || (typeof v === 'number' && (v < 0 || !Number.isInteger(v)))) {
        error(r, `«${COLUMNS[k]}»: нужна сумма целым числом, сейчас «${get(k)}»`, sku);
        return undefined;
      }
      return v;
    };
    const percent = (k: Column) => {
      const v = parseNumber(raw(k));
      if (v === 'bad' || (typeof v === 'number' && (v < 0 || v > 100 || Math.abs(Math.round(v * 100) - v * 100) > 1e-6))) {
        error(r, `«${COLUMNS[k]}»: нужен процент от 0 до 100 (не больше двух знаков после запятой), сейчас «${get(k)}»`, sku);
        return undefined;
      }
      return v;
    };
    const price = money('price');
    const oldPrice = money('old_price');
    const yPrice = money('yandex_price');
    const logistics = money('logistics');
    const commission = percent('commission');
    const fee = col.fee ? percent('fee') : null;

    // Dictionary values from the table
    const values: Partial<Record<DictionaryKind, string>> = {};
    for (const kind of Object.keys(DICT_COLUMN) as DictionaryKind[]) {
      const text = get(DICT_COLUMN[kind]);
      if (!text) continue;
      if (kind === 'forms') {
        const f = normalizeForm(text);
        if ('error' in f) {
          error(r, f.error, sku);
          continue;
        }
        if (f.note) warn(r, f.note, sku);
        values.forms = f.form;
      } else values[kind] = cleanName(text);
    }
    if (values.brands && values.manufacturers && matchKey(values.brands) === matchKey(values.manufacturers)) {
      warn(r, `производитель «${values.manufacturers}» совпадает с брендом — уточнить по упаковке`, sku);
    }

    const existing = await prisma.products.findUnique({ where: { sku } });
    const data: Record<string, unknown> = {};
    const link: Partial<Record<DictionaryKind, string>> = {};
    const changes: string[] = [];
    const notes: string[] = [];

    // Yandex fields (the table is the Yandex Market data itself: the price is synchronized by definition)
    const yandex: [string, number | null | undefined, unknown][] = [
      ['yandex_price_uzs', yPrice, existing?.yandex_price_uzs],
      ['yandex_commission_percent', commission, existing?.yandex_commission_percent],
      ['yandex_payment_fee_percent', fee, existing?.yandex_payment_fee_percent],
      ['yandex_logistics_uzs', logistics, existing?.yandex_logistics_uzs],
    ];
    for (const [field, value, now] of yandex) {
      if (value == null) continue;
      if (now == null || Number(now) !== value) {
        data[field] = value;
        changes.push(`${field} ${now == null ? '—' : Number(now)} → ${value}`);
      }
    }
    if (data.yandex_price_uzs !== undefined) {
      data.yandex_price_sync_needed = false;
      data.yandex_price_sync_changed_at = new Date();
    }

    if (!existing) {
      // New product: hidden until someone completes it in the admin panel.
      if (!get('name')) error(r, 'новый товар: пустое «Название товара (для сверки)»', sku);
      if (price == null) error(r, 'новый товар: пустая «Цена VITALO, сум»', sku);
      if (!values.manufacturers) error(r, 'новый товар: пустой «Производитель»', sku);
      Object.assign(data, {
        sku,
        name_ru: get('name'),
        status: 'hidden',
        min_stock: 0,
        price_uzs: price ?? undefined,
        old_price_uzs: oldPrice ?? null,
        brand: values.brands,
        manufacturer: values.manufacturers,
        country: values.countries ?? null,
        form: values.forms ?? null,
      });
      for (const [c, field] of FILL_TEXT) if (get(c)) data[field] = get(c);
      Object.assign(link, values);
      if (!get('name_uz')) warn(r, 'новый товар без названия на узбекском', sku);
    } else {
      // Existing product: only empty fields are filled.
      for (const [c, field] of FILL_TEXT) {
        const v = get(c);
        if (!v) continue;
        const now = existing[field];
        if (!now?.trim()) {
          data[field] = v;
          changes.push(`${field} заполнено`);
        } else if (!sameText(now, v)) notes.push(`${field}: в базе уже «${short(now)}», в таблице «${short(v)}» — не меняю`);
      }
      if (oldPrice != null) {
        if (existing.old_price_uzs == null) {
          data.old_price_uzs = oldPrice;
          changes.push(`old_price_uzs — → ${oldPrice}`);
        } else if (Number(existing.old_price_uzs) !== oldPrice) notes.push(`старая цена: в базе ${existing.old_price_uzs}, в таблице ${oldPrice} — не меняю`);
      }
      if (price != null && Number(existing.price_uzs) !== price) {
        notes.push(`цена VITALO: в базе ${existing.price_uzs}, в таблице ${price} — НЕ применяю (цена VITALO меняется только в админке)`);
      }
      // Dictionaries: link only a value that matches the product's own text; an empty country / form is filled.
      for (const kind of Object.keys(DICT_COLUMN) as DictionaryKind[]) {
        const value = values[kind];
        if (!value) continue;
        const cols = DICTIONARY_COLUMNS[kind];
        const text = existing[cols.text];
        if (!text?.trim() && (kind === 'countries' || kind === 'forms')) {
          data[cols.text] = value;
          link[kind] = value;
          changes.push(`${cols.text} заполнено`);
        } else if (text && matchKey(text) === matchKey(value)) {
          if (!existing[cols.id]) {
            link[kind] = value;
            changes.push(`${cols.text}: привязать к справочнику`);
          }
        } else notes.push(`${cols.label}: в базе «${text}», в таблице «${value}» — не меняю, справочник не привязан`);
      }
    }

    // Same length rules as the admin panel
    const check = plainToInstance(ProductInput, { sku, name_ru: 'x', brand: 'x', manufacturer: 'x', price_uzs: 0, ...data });
    for (const p of await validate(check, { forbidUnknownValues: false })) {
      if (data[p.property] !== undefined) error(r, `поле ${p.property}: ${Object.values(p.constraints ?? {}).join('; ')}`, sku);
    }

    for (const kind of Object.keys(link) as DictionaryKind[]) {
      const name = link[kind]!;
      if (!known[kind].has(matchKey(name))) {
        known[kind].add(matchKey(name));
        (plan.newValues[kind] ??= []).push(name);
      }
    }
    if (plan.errors.length > before) continue;
    plan.rows.push({
      row: r,
      sku,
      action: !existing ? 'create' : changes.length ? 'update' : 'unchanged',
      productId: existing?.id ?? null,
      name: get('name') || existing?.name_ru || sku,
      data,
      link,
      changes,
      notes,
    });
  }
  if (!plan.rows.length && !plan.errors.length) warn(0, 'В таблице нет товаров');
  return plan;
}

// ---------------------------------------------------------------- applying (one transaction)

export async function applyYandexImport(prisma: PrismaService, audit: AuditService, plan: YandexPlan): Promise<YandexResult> {
  if (plan.errors.length) throw new Error('В таблице есть ошибки — ничего не записано. Исправьте их и запустите проверку ещё раз.');
  const result: YandexResult = { created: [], updated: [], unchanged: [], dictionaryValues: [] };
  await prisma.$transaction(
    async (tx) => {
      for (const p of plan.rows) {
        if (p.action === 'unchanged') {
          result.unchanged.push(p.sku);
          continue;
        }
        const data: Record<string, unknown> = { ...p.data };
        for (const k of ['price_uzs', 'old_price_uzs', 'yandex_price_uzs', 'yandex_logistics_uzs']) if (typeof data[k] === 'number') data[k] = BigInt(data[k] as number);
        for (const kind of Object.keys(p.link) as DictionaryKind[]) {
          const { row, created } = await ensureDictionaryValue(tx, audit, kind, p.link[kind]!, null);
          if (created) result.dictionaryValues.push(`${DICTIONARY_COLUMNS[kind].label}: ${row.name_ru}`);
          data[DICTIONARY_COLUMNS[kind].id] = row.id;
          // The text column always carries the dictionary name (the Mini App reads it).
          if (p.action === 'create' || data[DICTIONARY_COLUMNS[kind].text] !== undefined) data[DICTIONARY_COLUMNS[kind].text] = row.name_ru;
        }
        if (p.action === 'create') {
          const created = await tx.products.create({ data: data as Prisma.productsUncheckedCreateInput });
          await audit.log({ staffId: null, action: 'product.created', entityType: 'product', entityId: created.id, after: { ...auditJson(created) as object, source: 'import:yandex' } }, tx);
          result.created.push(p.sku);
        } else {
          const before = await tx.products.findUniqueOrThrow({ where: { id: p.productId! } });
          const after = await tx.products.update({ where: { id: p.productId! }, data: data as Prisma.productsUncheckedUpdateInput });
          const changed = Object.keys(data);
          const pick = (o: Record<string, unknown>) => Object.fromEntries(changed.map((k) => [k, o[k]]));
          await audit.log(
            { staffId: null, action: 'product.updated', entityType: 'product', entityId: after.id, before: pick(before), after: { ...pick(after), source: 'import:yandex' } },
            tx,
          );
          result.updated.push(p.sku);
        }
      }
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
  return result;
}

// ---------------------------------------------------------------- report

const KIND_LABEL: Record<DictionaryKind, string> = { brands: 'бренды', manufacturers: 'производители', countries: 'страны', forms: 'формы' };

export function formatYandexPlan(plan: YandexPlan): string {
  const out: string[] = [];
  const label = { create: 'СОЗДАТЬ (скрытый, только в админке)', update: 'ОБНОВИТЬ', unchanged: 'без изменений' };
  for (const p of plan.rows) {
    out.push(`[строка ${p.row}] ${p.sku} — ${short(p.name)}: ${label[p.action]}`);
    if (p.action === 'create') {
      const d = p.data;
      out.push(`    цена VITALO ${d.price_uzs}${d.old_price_uzs != null ? `, старая ${d.old_price_uzs}` : ''}; Яндекс ${d.yandex_price_uzs ?? '—'}, комиссия ${d.yandex_commission_percent ?? '—'}%, сбор ${d.yandex_payment_fee_percent ?? '—'}%, логистика ${d.yandex_logistics_uzs ?? '—'}`);
      out.push(`    бренд «${d.brand}», производитель «${d.manufacturer}», страна «${d.country ?? '—'}», форма «${d.form ?? '—'}»; без категорий, фото и остатка`);
    } else if (p.changes.length) out.push(`    изменится: ${p.changes.join('; ')}`);
    for (const n of p.notes) out.push(`    не применяется: ${n}`);
  }
  const values = Object.entries(plan.newValues).filter(([, v]) => v?.length);
  if (values.length) {
    out.push('', 'Новые значения справочников:');
    for (const [k, v] of values) out.push(`  ${KIND_LABEL[k as DictionaryKind]}: ${v!.join(', ')}`);
  }
  const list = (title: string, items: YandexIssue[]) => {
    if (!items.length) return;
    out.push('', `${title} (${items.length}):`);
    for (const i of items) out.push(`  - ${i.row ? `строка ${i.row}` : 'файл'}${i.sku ? `, ${i.sku}` : ''}: ${i.message}`);
  };
  list('ОШИБКИ — запись невозможна, пока их не исправить', plan.errors);
  list('Предупреждения', plan.warnings);
  const n = (a: YandexRowPlan['action']) => plan.rows.filter((r) => r.action === a).length;
  out.push('', `Итого: создать ${n('create')}, обновить ${n('update')}, без изменений ${n('unchanged')}; ошибок ${plan.errors.length}, предупреждений ${plan.warnings.length}.`);
  return out.join('\n');
}

export function formatYandexResult(r: YandexResult): string {
  return [
    `Создано товаров (скрытые): ${r.created.length}${r.created.length ? ` (${r.created.join(', ')})` : ''}`,
    `Обновлено: ${r.updated.length}${r.updated.length ? ` (${r.updated.join(', ')})` : ''}`,
    `Без изменений: ${r.unchanged.length}`,
    `Новые значения справочников: ${r.dictionaryValues.length ? r.dictionaryValues.join('; ') : 'нет'}`,
  ].join('\n');
}
