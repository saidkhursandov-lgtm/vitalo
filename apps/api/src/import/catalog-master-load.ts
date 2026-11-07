/**
 * Loading the checked master table docs/content/VITALO_catalog.xlsx into the database (npm run catalog:load).
 *
 * - The plan is exactly the check (`checkCatalog`): what the report «было → стало» shows is what is written, nothing else.
 *   Any error of the check, an untranslated UZ text, a new category or a merge of categories → nothing is written.
 * - Order in ONE transaction: substances → categories → brands → products → rules (a product or a rule may use a
 *   substance or a brand added by the same table). All or nothing.
 * - Nothing is deleted: «В архив» archives a product or a brand, «Выключить» switches a rule off. Only the links of a
 *   changed product to its needs / type / substances are replaced (as the admin panel does).
 * - A new product gets the next free SKU OZN-A### (shown in the plan before writing). A new row whose «Полное название
 *   RU» is already taken by a product of the database is an error: a second run of the same file never adds twins.
 * - Not loaded, only listed: photos and brand logos (the admin panel uploads them) and the columns without a database
 *   field yet (question 76).
 * - Every change is in the audit log (`source: catalog:load`, no employee).
 */
import { Prisma, ProductStatus } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'crypto';
import { shellRule } from '../catalog/card-content';
import { RULE_KIND_LABELS, WHEN_LABELS, normalizeText } from '../compat/knowledge';
import { DICTIONARY_COLUMNS, matchKey, type DictionaryKind } from '../dictionaries/dictionary-names';
import type { PrismaService } from '../prisma/prisma.service';
import { ensureDictionaryValue, freeBrandSlug } from '../staff/admin-dictionaries';
import { ProductInput } from '../staff/admin-products';
import { auditJson, type AuditService } from '../staff/audit.service';
import {
  ACTION,
  BRANDS_SHEET,
  CATEGORIES_SHEET,
  HALAL,
  PRODUCTS_SHEET,
  PRODUCT_STATUS,
  RULES_SHEET,
  RULE_ACTION,
  SUBSTANCES_SHEET,
  YES,
  checkCatalog,
  clean,
  loadCatalogDb,
  productCell,
  sameCell,
  splitList,
  toNumber,
  type CatalogCheck,
  type CatalogDb,
  type CatalogSheets,
  type Cell,
  type Change,
  type DictItem,
  type Issue,
  type SheetRow,
} from './catalog-master';

const SOURCE = 'catalog:load';
export const SKU_PREFIX = 'OZN-A';
const lc = (s: string) => normalizeText(s);

/** Product columns of the sheet → fields of `products` (dictionaries, needs, type, substances, status go apart). */
const PRODUCT_FIELDS: Record<string, string> = {
  name_ru: 'name_ru',
  name_uz: 'name_uz',
  short_ru: 'short_name_ru',
  short_uz: 'short_name_uz',
  sform_ru: 'substance_form_ru',
  sform_uz: 'substance_form_uz',
  pack: 'pack_count',
  per_day: 'servings_per_day',
  price: 'price_uzs',
  cost: 'cost_uzs',
  market: 'market_advantage_percent',
  desc_ru: 'short_description_ru',
  desc_uz: 'short_description_uz',
  comp_ru: 'composition_ru',
  comp_uz: 'composition_uz',
  dir_ru: 'directions_ru',
  dir_uz: 'directions_uz',
  warn_ru: 'warnings_ru',
  warn_uz: 'warnings_uz',
  verdict_ru: 'doctor_verdict_ru',
  verdict_uz: 'doctor_verdict_uz',
  memo_ru: 'intake_memo_ru',
  memo_uz: 'intake_memo_uz',
  std_bio: 'std_bioavailability',
  std_tested: 'std_tested',
  std_orig: 'std_original',
  halal: 'halal_vege',
  shell: 'shell_ru',
  halal_src: 'halal_vege_source',
  weight: 'shipping_weight_g',
};
const NUMBER_FIELDS = new Set(['pack', 'per_day', 'price', 'cost', 'market', 'weight']);
const BOOL_FIELDS = new Set(['std_bio', 'std_tested', 'std_orig']);
const DICT_KEY: Record<DictionaryKind, string> = { brands: 'brand', manufacturers: 'manufacturer', countries: 'country', forms: 'form' };
const HALAL_CODE = new Map(Object.entries(HALAL).map(([k, v]) => [lc(v), k]));
const STATUS_CODE = new Map(Object.entries(PRODUCT_STATUS).map(([k, v]) => [lc(v), k as ProductStatus]));

// ---------------------------------------------------------------- the plan

export interface ProductOp {
  row: number;
  action: string;
  /** existing SKU or the one the new product gets */
  sku: string;
  productId: string | null;
  data: Record<string, unknown>;
  dicts: Partial<Record<DictionaryKind, string>>;
  /** null = the links of that kind stay as they are */
  needs: string[] | null;
  type: string | null;
  substances: string[] | null;
}

export interface CatalogLoadPlan {
  check: CatalogCheck;
  /** errors of the loading itself (the check's errors are in `check.errors`) */
  errors: Issue[];
  warnings: Issue[];
  newSkus: { row: number; sku: string; name: string }[];
  products: ProductOp[];
  sheets: CatalogSheets;
  db: CatalogDb;
}

export interface CatalogLoadResult {
  substances: { created: number; updated: number };
  categories: number;
  brands: { created: number; updated: number; archived: number };
  products: { created: string[]; updated: string[]; archived: string[] };
  rules: { created: number; updated: number; approved: number; off: number };
  dictionaryValues: string[];
}

const rowsOf = (list: SheetRow[] | null) => new Map((list ?? []).map((r) => [r.row, r]));
const textOrNull = (v: Cell | undefined) => clean(v) || null;
const fieldLabels = (c: Change) => c.fields.map((f) => f.label);

/** Product sheet cell → the value of its database field. */
function productValue(k: string, v: Cell | undefined): unknown {
  if (NUMBER_FIELDS.has(k)) {
    const n = toNumber(v);
    return n == null || Number.isNaN(n) ? null : Math.round(n);
  }
  if (BOOL_FIELDS.has(k)) return clean(v) === YES;
  if (k === 'halal') return clean(v) ? HALAL_CODE.get(lc(clean(v))) ?? null : null;
  if (k === 'shell') return shellRule(textOrNull(v)).ru;
  return textOrNull(v);
}

/** Next free OZN-A### after every SKU of the database (archived ones included). */
export function nextSkus(taken: string[], count: number): string[] {
  const re = new RegExp(`^${SKU_PREFIX}(\\d+)$`, 'i');
  let n = taken.reduce((m, s) => Math.max(m, Number(re.exec(s)?.[1] ?? 0)), 0);
  const all = new Set(taken.map((s) => s.toUpperCase()));
  const out: string[] = [];
  while (out.length < count) {
    const sku = `${SKU_PREFIX}${String(++n).padStart(3, '0')}`;
    if (!all.has(sku)) out.push(sku);
  }
  return out;
}

export async function planCatalogLoad(prisma: PrismaService, sheets: CatalogSheets): Promise<CatalogLoadPlan> {
  const db = await loadCatalogDb(prisma);
  const check = checkCatalog(sheets, db);
  const plan: CatalogLoadPlan = { check, errors: [], warnings: [], newSkus: [], products: [], sheets, db };
  if (check.errors.length) return plan;
  const error = (sheet: string, row: number | null, message: string) => plan.errors.push({ sheet, row, message });
  const warn = (sheet: string, row: number | null, message: string) => plan.warnings.push({ sheet, row, message });

  if (check.translate.length) error('Переводы', null, `не переведено на узбекский: ${check.translate.length} — сначала переводы (их проверяет владелец), потом загрузка`);

  for (const c of check.changes.filter((x) => x.sheet === CATEGORIES_SHEET)) {
    if (c.action === 'Новая') error(CATEGORIES_SHEET, c.row, `«${c.what}»: новая категория — добавьте её в админке (Каталог → Категории), загрузка из таблицы пока только меняет существующие`);
    if (fieldLabels(c).includes('Объединить с')) error(CATEGORIES_SHEET, c.row, `«${c.what}»: объединение категорий — в админке (Каталог → Категории), из таблицы не загружается`);
  }
  for (const c of check.changes.filter((x) => x.sheet === BRANDS_SHEET)) {
    if (fieldLabels(c).includes('Файл логотипа')) warn(BRANDS_SHEET, c.row, `«${c.what}»: логотип загружается в админке (Каталог → Бренды) — из таблицы не загрузится`);
  }

  // ---- products
  const all = await prisma.products.findMany({ select: { sku: true, name_ru: true } });
  const byName = new Map(all.map((p) => [lc(p.name_ru), p.sku]));
  const rows = rowsOf(sheets.products);
  const bySku = new Map(db.products.map((p) => [p.sku.toUpperCase(), p]));
  const creates = check.changes.filter((c) => c.sheet === PRODUCTS_SHEET && c.action === ACTION.create);
  const skus = nextSkus(all.map((p) => p.sku), creates.filter((c) => !clean(rows.get(c.row!)!.v.sku)).length);
  const namesInTable = new Map<string, number>();
  const lookup = new Map<string, string>();
  for (const d of check.dict) for (const s of [d.code, d.name_ru, d.name_uz, ...d.synonyms]) if (s && !lookup.has(lc(s))) lookup.set(lc(s), d.code);

  for (const c of check.changes.filter((x) => x.sheet === PRODUCTS_SHEET)) {
    const r = rows.get(c.row!)!;
    const v = r.v;
    const sheetSku = clean(v.sku).toUpperCase();
    const old = sheetSku ? bySku.get(sheetSku) : undefined;
    const labels = fieldLabels(c);
    if (labels.includes('Фото')) warn(PRODUCTS_SHEET, r.row, `${c.what}: фото загружаются в админке (товар → «Добавить фото») — из таблицы не загрузятся`);

    if (c.action === ACTION.archive) {
      plan.products.push({ row: r.row, action: c.action, sku: old!.sku, productId: old!.id, data: { status: 'archived' }, dicts: {}, needs: null, type: null, substances: null });
      continue;
    }
    const isNew = c.action === ACTION.create;
    const name = clean(v.name_ru);
    if (isNew) {
      const twin = byName.get(lc(name));
      if (twin) error(PRODUCTS_SHEET, r.row, `«${name}»: товар с таким полным названием уже есть (${twin}) — впишите его артикул и поставьте «Изменить»`);
      if (namesInTable.has(lc(name))) error(PRODUCTS_SHEET, r.row, `«${name}»: такое же полное название в строке ${namesInTable.get(lc(name))}`);
      namesInTable.set(lc(name), r.row);
      if (!clean(v.manufacturer)) error(PRODUCTS_SHEET, r.row, `«${name}»: не заполнен «Производитель (юрлицо)» — без него товар не сохранить`);
    }

    const data: Record<string, unknown> = {};
    const base = old?.cells ?? {};
    for (const [k, field] of Object.entries(PRODUCT_FIELDS)) {
      if (!isNew && sameCell(productCell(k, base[k]), productCell(k, v[k]))) continue;
      data[field] = productValue(k, v[k]);
      if (k === 'shell') data.shell_uz = shellRule(textOrNull(v[k])).uz;
    }
    if (data.shell_ru && !data.shell_uz) warn(PRODUCTS_SHEET, r.row, `${c.what}: нет перевода оболочки «${String(data.shell_ru)}» на узбекский — строка будет только по-русски`);
    const status = clean(v.status) ? STATUS_CODE.get(lc(clean(v.status))) : undefined;
    if (isNew) data.status = status ?? 'active';
    else if (status && status !== old!.status) data.status = status;

    const dicts: Partial<Record<DictionaryKind, string>> = {};
    for (const [kind, k] of Object.entries(DICT_KEY) as [DictionaryKind, string][]) {
      const text = clean(v[k]);
      if (!text) {
        if (!isNew && clean(base[k])) warn(PRODUCTS_SHEET, r.row, `${c.what}: «${k === 'brand' ? 'Бренд' : k === 'form' ? 'Форма выпуска' : k === 'country' ? 'Страна' : 'Производитель'}» пустой — в базе остаётся «${clean(base[k])}»`);
        continue;
      }
      if (isNew || !sameCell(base[k], text)) dicts[kind] = text;
    }

    const sheetNeeds = ['need1', 'need2', 'need3'].map((k) => clean(v[k])).filter(Boolean);
    const needs = isNew || labels.includes('Потребности') ? sheetNeeds : null;
    const type = isNew || !sameCell(base.type, v.type) ? clean(v.type) || null : null;
    const codes = splitList(v.substances).map((n) => lookup.get(lc(n))!).filter(Boolean);
    const substances = isNew || labels.includes('Действующие вещества') ? [...new Set(codes)] : null;

    // the same limits as the admin panel (lengths, numbers)
    const merged: Record<string, unknown> = { sku: old?.sku ?? 'NEW-1', name_ru: name || 'x', brand: clean(v.brand) || 'x', manufacturer: clean(v.manufacturer) || 'x', price_uzs: 0, ...data };
    for (const p of await validate(plainToInstance(ProductInput, merged), { forbidUnknownValues: false })) {
      if (data[p.property] !== undefined && data[p.property] !== null) error(PRODUCTS_SHEET, r.row, `${c.what}: поле ${p.property}: ${Object.values(p.constraints ?? {}).join('; ')}`);
    }

    let sku = old?.sku ?? sheetSku;
    if (isNew && !sku) {
      sku = skus.shift()!;
      plan.newSkus.push({ row: r.row, sku, name: clean(v.short_ru) || name });
    }
    plan.products.push({ row: r.row, action: c.action, sku, productId: old?.id ?? null, data, dicts, needs, type, substances });
  }
  return plan;
}

// ---------------------------------------------------------------- writing

function toDb(data: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...data };
  for (const k of ['price_uzs', 'cost_uzs']) if (typeof out[k] === 'number') out[k] = BigInt(out[k] as number);
  return out;
}

export async function applyCatalogLoad(prisma: PrismaService, audit: AuditService, plan: CatalogLoadPlan): Promise<CatalogLoadResult> {
  if (plan.check.errors.length || plan.errors.length) throw new Error('В таблице есть ошибки — ничего не записано. Исправьте их и запустите проверку ещё раз.');
  const { check, sheets } = plan;
  const result: CatalogLoadResult = {
    substances: { created: 0, updated: 0 },
    categories: 0,
    brands: { created: 0, updated: 0, archived: 0 },
    products: { created: [], updated: [], archived: [] },
    rules: { created: 0, updated: 0, approved: 0, off: 0 },
    dictionaryValues: [],
  };
  const changes = (sheet: string) => check.changes.filter((c) => c.sheet === sheet);
  const log = (tx: Prisma.TransactionClient, action: string, entityType: string, entityId: string, before: unknown, after: unknown) =>
    audit.log({ staffId: null, action, entityType, entityId, before: before == null ? undefined : (auditJson(before) as object), after: { ...(auditJson(after) as object), source: SOURCE } }, tx);

  await prisma.$transaction(
    async (tx) => {
      // ---- 1. substances (then their parents: a form may point to a substance created in the same run)
      const dictByRow = new Map(check.dict.filter((d) => d.row != null).map((d) => [d.row!, d]));
      const touched: DictItem[] = [];
      for (const c of changes(SUBSTANCES_SHEET)) {
        const d = dictByRow.get(c.row!)!;
        const data = { name_ru: d.name_ru, name_uz: d.name_uz, kind: d.kind, synonyms: d.synonyms, enabled: d.enabled, ...(d.order != null && { sort_order: d.order }) };
        if (d.isNew) {
          const s = await tx.substances.create({ data: { code: d.code, ...data } });
          await log(tx, 'substance.created', 'substances', s.id, null, s);
          result.substances.created++;
        } else {
          const before = await tx.substances.findUniqueOrThrow({ where: { code: d.code } });
          const s = await tx.substances.update({ where: { code: d.code }, data });
          await log(tx, 'substance.updated', 'substances', s.id, before, s);
          result.substances.updated++;
        }
        touched.push(d);
      }
      const subId = new Map((await tx.substances.findMany({ select: { id: true, code: true } })).map((s) => [s.code, s.id]));
      for (const d of touched) await tx.substances.update({ where: { code: d.code }, data: { parent_id: d.parent ? subId.get(d.parent)! : null } });

      // ---- 2. categories: names, «Показывать», order (new ones and merges were refused by the plan)
      const catRows = rowsOf(sheets.categories);
      for (const c of changes(CATEGORIES_SHEET)) {
        const v = catRows.get(c.row!)!.v;
        const before = await tx.categories.findUniqueOrThrow({ where: { slug: clean(v.slug) } });
        const order = toNumber(v.order);
        const after = await tx.categories.update({
          where: { id: before.id },
          data: { name_ru: clean(v.name_ru), name_uz: clean(v.name_uz), status: (clean(v.show) || YES) === YES ? 'active' : 'archived', ...(order != null && !Number.isNaN(order) && fieldLabels(c).includes('Порядок') && { sort_order: order }) },
        });
        await log(tx, 'category.updated', 'categories', after.id, before, after);
        result.categories++;
      }

      // ---- 3. brands
      const brandRows = rowsOf(sheets.brands);
      for (const c of changes(BRANDS_SHEET)) {
        const v = brandRows.get(c.row!)!.v;
        const name = clean(v.name);
        const order = toNumber(v.order);
        const data = {
          country_ru: textOrNull(v.country_ru),
          country_uz: textOrNull(v.country_uz),
          why_vitalo_ru: textOrNull(v.why_ru),
          why_vitalo_uz: textOrNull(v.why_uz),
          ...(clean(v.show) && { show_in_showcase: clean(v.show) === YES }),
          ...(order != null && !Number.isNaN(order) && { sort_order: order }),
        };
        if (c.action === ACTION.create) {
          const b = await tx.brands.create({ data: { name_ru: name, slug: await freeBrandSlug(tx, name), ...data } });
          await log(tx, 'brand.created', 'brands', b.id, null, b);
          result.brands.created++;
          continue;
        }
        const before = (await tx.brands.findMany()).find((b) => matchKey(b.name_ru) === matchKey(name))!;
        const after = await tx.brands.update({ where: { id: before.id }, data: c.action === ACTION.archive ? { status: 'archived' } : data });
        await log(tx, c.action === ACTION.archive ? 'brand.archived' : 'brand.updated', 'brands', after.id, before, after);
        if (c.action === ACTION.archive) result.brands.archived++;
        else result.brands.updated++;
      }

      // ---- 4. products
      const cats = await tx.categories.findMany({ where: { status: 'active', parent_id: null } });
      const catId = (tree: 'need' | 'product_type', name: string) => cats.find((x) => x.tree_type === tree && lc(x.name_ru) === lc(name))?.id;
      const relink = async (productId: string, tree: 'need' | 'product_type', names: string[]) => {
        const top = await tx.categories.findMany({ where: { tree_type: tree, parent_id: null }, select: { id: true } });
        await tx.product_categories.deleteMany({ where: { product_id: productId, category_id: { in: top.map((x) => x.id) } } });
        const ids = names.map((n) => catId(tree, n)).filter((x): x is string => !!x);
        if (ids.length) await tx.product_categories.createMany({ data: ids.map((category_id) => ({ product_id: productId, category_id })), skipDuplicates: true });
      };
      for (const op of plan.products) {
        const data = toDb(op.data);
        for (const kind of Object.keys(op.dicts) as DictionaryKind[]) {
          const { row, created } = await ensureDictionaryValue(tx, audit, kind, op.dicts[kind]!, null);
          if (created) result.dictionaryValues.push(`${DICTIONARY_COLUMNS[kind].label}: ${row.name_ru}`);
          data[DICTIONARY_COLUMNS[kind].id] = row.id;
          data[DICTIONARY_COLUMNS[kind].text] = row.name_ru; // the Mini App reads the text
        }
        let id = op.productId;
        if (!id) {
          const p = await tx.products.create({ data: { ...(data as Prisma.productsUncheckedCreateInput), id: randomUUID(), sku: op.sku } });
          id = p.id;
          await log(tx, 'product.created', 'product', id, null, p);
          result.products.created.push(op.sku);
        } else if (Object.keys(data).length) {
          const before = await tx.products.findUniqueOrThrow({ where: { id } });
          const after = await tx.products.update({ where: { id }, data: data as Prisma.productsUncheckedUpdateInput });
          const pick = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(data).map((k) => [k, o[k]]));
          await log(tx, op.action === ACTION.archive ? 'product.archived' : 'product.updated', 'product', id, pick(before), pick(after));
        }
        if (op.needs) await relink(id, 'need', op.needs);
        if (op.type) await relink(id, 'product_type', [op.type]);
        if (op.substances) {
          const before = await tx.product_substances.findMany({ where: { product_id: id }, select: { substance_id: true } });
          await tx.product_substances.deleteMany({ where: { product_id: id } });
          if (op.substances.length) await tx.product_substances.createMany({ data: op.substances.map((code) => ({ product_id: id!, substance_id: subId.get(code)! })) });
          if (op.productId) await log(tx, 'product.substances', 'product', id, { substance_ids: before.map((x) => x.substance_id) }, { substances: op.substances });
        }
        if (op.productId && op.action === ACTION.archive) result.products.archived.push(op.sku);
        else if (op.productId) result.products.updated.push(op.sku);
      }

      // ---- 5. compatibility rules
      const ruleRows = rowsOf(sheets.rules);
      const lookup = new Map<string, string>();
      for (const d of check.dict) for (const s of [d.code, d.name_ru, d.name_uz, ...d.synonyms]) if (s && !lookup.has(lc(s))) lookup.set(lc(s), d.code);
      const kindOf = new Map(Object.entries(RULE_KIND_LABELS).map(([k, l]) => [lc(l.ru), k]));
      const whenOf = new Map(Object.entries(WHEN_LABELS).map(([k, l]) => [lc(l.ru), k]));
      const now = new Date();
      for (const c of changes(RULES_SHEET)) {
        const v = ruleRows.get(c.row!)!.v;
        // the change's label («Изменить и одобрить», «Одобрить»…) is for the report; the row's own «Действие» decides
        const action = clean(v.action) || RULE_ACTION.same;
        const a = subId.get(lookup.get(lc(clean(v.a)))!)!;
        const b = subId.get(lookup.get(lc(clean(v.b)))!)!;
        const approve = clean(v.approve) === YES;
        const whenA = clean(v.when_a) ? whenOf.get(lc(clean(v.when_a)))! : null;
        const whenB = clean(v.when_b) ? whenOf.get(lc(clean(v.when_b)))! : null;
        const interval = toNumber(v.interval);
        const fields = { kind: kindOf.get(lc(clean(v.kind)))!, interval_hours: interval == null ? null : interval, text_ru: clean(v.text_ru), text_uz: clean(v.text_uz), source: textOrNull(v.source) };
        const approved = { status: 'approved', approved_by: null, approved_at: now };
        if (action === RULE_ACTION.create) {
          const rule = await tx.compat_rules.create({ data: { substance_a_id: a, substance_b_id: b, when_a: whenA, when_b: whenB, ...fields, origin: 'xlsx', ...(approve ? approved : { status: 'draft' }) } });
          await log(tx, 'compat_rule.created', 'compat_rules', rule.id, null, rule);
          result.rules.created++;
          continue;
        }
        const before = await tx.compat_rules.findUniqueOrThrow({ where: { id: clean(v.id) } });
        let data: Prisma.compat_rulesUncheckedUpdateInput;
        if (action === RULE_ACTION.off) {
          data = { status: 'off' };
          result.rules.off++;
        } else if (action === RULE_ACTION.same) {
          data = approved; // «Без изменений» + «Одобрить: Да»
          result.rules.approved++;
        } else {
          // the stored rule keeps its A → B order
          const swapped = before.substance_a_id === b && before.substance_b_id === a;
          data = { substance_a_id: swapped ? b : a, substance_b_id: swapped ? a : b, when_a: swapped ? whenB : whenA, when_b: swapped ? whenA : whenB, ...fields, ...(approve && before.status !== 'approved' && approved) };
          result.rules.updated++;
        }
        const after = await tx.compat_rules.update({ where: { id: before.id }, data });
        await log(tx, 'compat_rule.updated', 'compat_rules', after.id, before, after);
      }
    },
    { maxWait: 10_000, timeout: 300_000 },
  );
  return result;
}

// ---------------------------------------------------------------- report

const where = (i: Issue) => `${i.sheet}${i.row ? `, стр. ${i.row}` : ''}`;

export function formatLoadPlan(plan: CatalogLoadPlan): string {
  const out: string[] = [];
  if (plan.errors.length) {
    out.push(`## Загрузка невозможна — ${plan.errors.length}`, '');
    for (const e of plan.errors) out.push(`- ${where(e)}: ${e.message}`);
    out.push('');
  }
  if (plan.newSkus.length) {
    out.push(`## Артикулы новых товаров (${plan.newSkus.length})`, '', '| Стр. | Артикул | Товар |', '| --- | --- | --- |');
    for (const s of plan.newSkus) out.push(`| ${s.row} | ${s.sku} | ${s.name.replace(/\|/g, '/')} |`);
    out.push('', 'После загрузки выгрузите таблицу заново (npm run catalog:export): артикулы появятся в файле.', '');
  }
  if (plan.warnings.length) {
    out.push(`## Не загрузится из таблицы (${plan.warnings.length})`, '');
    for (const w of plan.warnings) out.push(`- ${where(w)}: ${w.message}`);
    out.push('');
  }
  return out.join('\n');
}

export function formatLoadResult(r: CatalogLoadResult): string {
  const list = (a: string[]) => (a.length ? ` (${a.join(', ')})` : '');
  return [
    `Вещества: новых ${r.substances.created}, изменено ${r.substances.updated}`,
    `Категории: изменено ${r.categories}`,
    `Бренды: новых ${r.brands.created}, изменено ${r.brands.updated}, в архив ${r.brands.archived}`,
    `Товары: новых ${r.products.created.length}${list(r.products.created)}; изменено ${r.products.updated.length}${list(r.products.updated)}; в архив ${r.products.archived.length}${list(r.products.archived)}`,
    `Правила: новых ${r.rules.created}, изменено ${r.rules.updated}, одобрено ${r.rules.approved}, выключено ${r.rules.off}`,
    `Новые значения справочников: ${r.dictionaryValues.length ? r.dictionaryValues.join('; ') : 'нет'}`,
  ].join('\n');
}
