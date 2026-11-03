/**
 * The master table of the catalog docs/content/VITALO_catalog.xlsx (sheets «Товары», «Бренды», «Категории»,
 * «Вещества», «Правила совместимости»): what the database has → the table (npm run catalog:export) and the check of an
 * edited table before loading (npm run catalog:check) — errors and «было → стало». Nothing here writes to the database.
 *
 * - The database side is a plain snapshot (`CatalogDb`), read in one READ ONLY transaction (`loadCatalogDb`).
 * - A product / brand / substance / rule is changed only by its row's «Действие» (Изменить, Новый / Новое, В архив,
 *   Выключить); a row «Без изменений» that differs from the database is only a warning. Nothing is ever deleted.
 * - Substances of products and of rules must be names from the sheet «Вещества» (name RU / UZ, a synonym or the code);
 *   an unknown name is an error with the closest names as a hint.
 * - «Одобрить: Да» on a rule = the owner (an admin) approves it; an admin's own edit keeps an approved rule approved.
 */
import ExcelJS from 'exceljs';
import type { PrismaService } from '../prisma/prisma.service';
import { normalizeText, RULE_KIND_LABELS, WHEN_LABELS, type RuleKind, type When } from '../compat/knowledge';

export const PRODUCTS_SHEET = 'Товары';
export const BRANDS_SHEET = 'Бренды';
export const CATEGORIES_SHEET = 'Категории';
export const SUBSTANCES_SHEET = 'Вещества';
export const RULES_SHEET = 'Правила совместимости';
export const LISTS_SHEET = 'Справочники';

/** Data starts at row 4 (row 1 — groups, row 2 — headers, row 3 — example) on every sheet except «Категории». */
export const FIRST_ROW = 4;
export const LAST_ROW = 300;

/** Owner's decision 02.11.2026 (question 73): the archived protein OZN-A016 is not in the master table. */
export const EXCLUDED_SKUS = ['OZN-A016'];

export const ACTION = { same: 'Без изменений', change: 'Изменить', create: 'Новый', archive: 'В архив' } as const;
export const RULE_ACTION = { same: 'Без изменений', change: 'Изменить', create: 'Новое', off: 'Выключить' } as const;
export const SUBSTANCE_ACTION = { same: 'Без изменений', change: 'Изменить', create: 'Новое' } as const;

export const PRODUCT_STATUS: Record<string, string> = { active: 'Активен', hidden: 'Скрыт', archived: 'Архив' };
export const RULE_STATUS: Record<string, string> = { draft: 'Черновик', approved: 'Одобрено', off: 'Выключено' };
export const SUBSTANCE_KIND: Record<string, string> = { substance: 'Вещество', form: 'Форма вещества', drug_group: 'Группа лекарств' };
export const HALAL: Record<string, string> = { halal: 'Halal', vege: 'VEGE', halal_vege: 'Halal и VEGE', none: 'Нет', unknown: 'Не знаю' };
export const YES = 'Да';
export const NO = 'Нет';
export const TRANSLATE = 'Перевести Claude (проверю)';

/** Values of the drop-down lists (sheet «Справочники»): the check uses the same lists as the file. */
export const LISTS = {
  forms: ['Капсулы', 'Мягкие капсулы', 'Таблетки', 'Жевательные таблетки', 'Порошок', 'Жидкость', 'Капли', 'Мармелад', 'Саше', 'Другое'],
  units: ['капсул', 'таблеток', 'г', 'мл', 'саше', 'порций'],
  shells: ['Растительная (HPMC)', 'Говяжий желатин', 'Рыбий желатин', 'Свиной желатин', 'Без капсулы', 'Не знаю'],
  translate: ['Я заполнил сам', TRANSLATE],
};

// ---------------- cells ----------------

export type Cell = string | number | null;

export function cellValue(v: ExcelJS.CellValue): Cell {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? YES : NO;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((t) => t.text).join('');
  if (typeof v === 'object' && 'formula' in v) return null; // «Дней курса» and other computed cells are never loaded
  if (typeof v === 'object' && 'sharedFormula' in v) return null;
  if (typeof v === 'object' && 'text' in v) return String(v.text);
  return String(v);
}

/** Text of a cell as compared: line breaks unified, spaces collapsed, trimmed. */
export const clean = (v: Cell | undefined): string =>
  v == null ? '' : String(v).replace(/\r\n?/g, '\n').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').trim();

/** A number written as 18.5, «18,5» or «5 000»; null = empty, NaN = not a number. */
export function toNumber(v: Cell | undefined): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const t = String(v).replace(/[\s  ]/g, '').replace(',', '.');
  return t === '' ? null : /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

/**
 * «a, b; c» → ['a', 'b', 'c'] (commas, semicolons or new lines; empty pieces dropped). A comma inside brackets does
 * not split: «Лекарства: антибиотики (тетрациклины, фторхинолоны)» is one name.
 */
export function splitList(v: Cell | undefined): string[] {
  const out: string[] = [];
  let depth = 0;
  let piece = '';
  for (const ch of clean(v)) {
    if (ch === '(' || ch === '[') depth++;
    if ((ch === ')' || ch === ']') && depth > 0) depth--;
    if (depth === 0 && (ch === ',' || ch === ';' || ch === '\n')) {
      out.push(piece);
      piece = '';
    } else piece += ch;
  }
  out.push(piece);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** First line of a header, lower case, without «*», «✚» and extra spaces: how columns are found. */
export const headerKey = (v: Cell | undefined) =>
  clean(v)
    .split('\n')[0]
    .toLowerCase()
    .replace(/[*✚]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const lc = (s: string) => normalizeText(s);

// ---------------- columns ----------------

interface ColumnDef {
  key: string;
  /** start of the first line of the header (headerKey) */
  head: string;
  label: string;
}

const col = (key: string, head: string, label = head) => ({ key, head, label });

export const PRODUCT_COLUMNS: ColumnDef[] = [
  col('sku', 'артикул', 'Артикул'),
  col('action', 'действие', 'Действие'),
  col('status', 'статус', 'Статус'),
  col('brand', 'бренд', 'Бренд'),
  col('name_ru', 'полное название ru', 'Полное название RU'),
  col('name_uz', 'полное название uz', 'Полное название UZ'),
  col('short_ru', 'короткое название ru', 'Короткое название RU'),
  col('short_uz', 'короткое название uz', 'Короткое название UZ'),
  col('need1', 'потребность 1', 'Потребность 1'),
  col('need2', 'потребность 2', 'Потребность 2'),
  col('need3', 'потребность 3', 'Потребность 3'),
  col('type', 'тип', 'Тип'),
  col('sform_ru', 'форма вещества ru', 'Форма вещества RU'),
  col('sform_uz', 'форма вещества uz', 'Форма вещества UZ'),
  col('form', 'форма выпуска', 'Форма выпуска'),
  col('pack', 'количество в упаковке', 'Количество в упаковке'),
  col('unit', 'единица', 'Единица'),
  col('portion', 'порция', 'Порция'),
  col('per_day', 'порций в день', 'Порций в день'),
  col('course', 'дней курса', 'Дней курса'),
  col('price', 'цена продажи', 'Цена продажи'),
  col('cost', 'закупочная цена', 'Закупочная цена'),
  col('market', 'выгоднее маркета', 'Выгоднее Маркета, %'),
  col('desc_ru', 'описание ru', 'Описание RU'),
  col('desc_uz', 'описание uz', 'Описание UZ'),
  col('comp_ru', 'состав ru', 'Состав RU'),
  col('comp_uz', 'состав uz', 'Состав UZ'),
  col('dir_ru', 'способ применения ru', 'Способ применения RU'),
  col('dir_uz', 'способ применения uz', 'Способ применения UZ'),
  col('warn_ru', 'противопоказания и предупреждения ru', 'Противопоказания RU'),
  col('warn_uz', 'противопоказания uz', 'Противопоказания UZ'),
  col('verdict_ru', 'вердикт врача ru', 'Вердикт врача RU'),
  col('verdict_uz', 'вердикт врача uz', 'Вердикт врача UZ'),
  col('memo_ru', 'памятка приёма ru', 'Памятка приёма RU'),
  col('memo_uz', 'памятка приёма uz', 'Памятка приёма UZ'),
  col('substances', 'действующие вещества', 'Действующие вещества'),
  col('std_bio', 'высокая биодоступность', 'Высокая биодоступность'),
  col('std_tested', 'проверенный состав', 'Проверенный состав'),
  col('std_orig', '100% оригинал', '100% оригинал'),
  col('halal', 'halal / vege', 'Halal / VEGE'),
  col('shell', 'оболочка капсулы', 'Оболочка капсулы'),
  col('halal_src', 'источник halal', 'Источник Halal/VEGE'),
  col('manufacturer', 'производитель', 'Производитель'),
  col('country', 'страна производства', 'Страна производства'),
  col('shelf', 'срок годности', 'Срок годности, мес'),
  col('storage', 'условия хранения', 'Условия хранения'),
  col('weight', 'вес с упаковкой', 'Вес с упаковкой, г'),
  col('ean', 'штрихкод', 'Штрихкод (EAN)'),
  col('ikpu', 'икпу', 'ИКПУ (MXIK)'),
  col('pack_code', 'код упаковки', 'Код упаковки'),
  col('photos', 'фото', 'Фото'),
  col('market_url', 'ссылка на товар на маркете', 'Ссылка на Маркет'),
  col('translate', 'перевод uz', 'Перевод UZ'),
  col('comment', 'комментарий', 'Комментарий'),
];

/** Product columns that have no field in the database yet (question 76): read, never compared or loaded. */
export const PRODUCT_NO_DB = ['unit', 'portion', 'shelf', 'storage', 'ean', 'ikpu', 'pack_code', 'market_url'];
/** Product columns that are not data: never compared. */
const PRODUCT_SERVICE = ['sku', 'action', 'course', 'translate', 'comment'];
const PRODUCT_NUMBERS = ['pack', 'per_day', 'price', 'cost', 'market', 'weight', 'shelf'];
const PRODUCT_TEXT_UZ = ['name_uz', 'short_uz', 'sform_uz', 'desc_uz', 'comp_uz', 'dir_uz', 'warn_uz', 'verdict_uz', 'memo_uz'];
/** Required for «Новый» and «Изменить» (the same columns are highlighted orange in the file). */
export const PRODUCT_REQUIRED = ['brand', 'name_ru', 'short_ru', 'need1', 'type', 'pack', 'price', 'comp_ru'];

export const BRAND_COLUMNS: ColumnDef[] = [
  col('name', 'бренд', 'Бренд'),
  col('action', 'действие', 'Действие'),
  col('country_ru', 'страна ru', 'Страна RU'),
  col('country_uz', 'страна uz', 'Страна UZ'),
  col('why_ru', 'почему бренд в vitalo', 'Почему в VITALO RU'),
  col('why_uz', '(uz)', 'Почему в VITALO UZ'),
  col('show', 'показывать в витрине', 'Показывать в витрине'),
  col('order', 'порядок', 'Порядок'),
  col('logo', 'файл логотипа', 'Файл логотипа'),
  col('comment', 'комментарий', 'Комментарий'),
];

export const CATEGORY_COLUMNS: ColumnDef[] = [
  col('code', 'код', 'Код'),
  col('name_ru', 'название ru', 'Название RU'),
  col('name_uz', 'название uz', 'Название UZ'),
  col('order', 'порядок', 'Порядок'),
  col('show', 'показывать', 'Показывать'),
  col('merge', 'объединить с', 'Объединить с'),
  col('comment', 'комментарий', 'Комментарий'),
  col('slug', 'адрес', 'Адрес'),
];

export const SUBSTANCE_COLUMNS: ColumnDef[] = [
  col('code', 'код', 'Код'),
  col('action', 'действие', 'Действие'),
  col('name_ru', 'название ru', 'Название RU'),
  col('name_uz', 'название uz', 'Название UZ'),
  col('kind', 'вид', 'Вид'),
  col('parent', 'форма какого вещества', 'Форма какого вещества'),
  col('synonyms', 'синонимы', 'Синонимы'),
  col('enabled', 'включено', 'Включено'),
  col('order', 'порядок', 'Порядок'),
  col('comment', 'комментарий', 'Комментарий'),
];

export const RULE_COLUMNS: ColumnDef[] = [
  col('a', 'вещество a', 'Вещество A'),
  col('b', 'вещество b', 'Вещество B'),
  col('kind', 'тип связи', 'Тип связи'),
  col('interval', 'интервал', 'Интервал, часов'),
  col('when_a', 'когда принимать a', 'Когда A'),
  col('when_b', 'когда принимать b', 'Когда B'),
  col('text_ru', 'объяснение для клиента ru', 'Объяснение RU'),
  col('text_uz', 'объяснение uz', 'Объяснение UZ'),
  col('source', 'источник', 'Источник'),
  col('status', 'статус', 'Статус'),
  col('action', 'действие', 'Действие'),
  col('approve', 'одобрить', 'Одобрить'),
  col('id', 'код правила', 'Код правила'),
];

// ---------------- reading the workbook ----------------

export interface SheetRow {
  row: number;
  /** column key → cell */
  v: Record<string, Cell>;
}

export interface CatalogSheets {
  products: SheetRow[] | null;
  brands: SheetRow[] | null;
  /** need / product_type blocks of «Категории» */
  categories: (SheetRow & { tree: 'need' | 'product_type' })[] | null;
  substances: SheetRow[] | null;
  rules: SheetRow[] | null;
  /** headers that were not found, per sheet */
  missing: { sheet: string; columns: string[] }[];
}

/** Column number of every key by the header row; keys whose header is missing are listed. */
export function mapColumns(header: ExcelJS.Row, defs: ColumnDef[]): { at: Record<string, number>; missing: string[] } {
  const heads: { k: number; h: string }[] = [];
  header.eachCell((c, k) => heads.push({ k, h: headerKey(cellValue(c.value)) }));
  const at: Record<string, number> = {};
  const used = new Set<number>();
  // longer headers first: «статус» must not take «статус правила», «название ru» must not take «полное название ru»
  for (const d of [...defs].sort((a, b) => b.head.length - a.head.length)) {
    const hit = heads.find((x) => !used.has(x.k) && x.h.startsWith(d.head));
    if (hit) {
      at[d.key] = hit.k;
      used.add(hit.k);
    }
  }
  return { at, missing: defs.filter((d) => !at[d.key]).map((d) => d.label) };
}

function readRows(ws: ExcelJS.Worksheet, at: Record<string, number>, from: number, to: number): SheetRow[] {
  const out: SheetRow[] = [];
  for (let i = from; i <= Math.min(to, ws.rowCount); i++) {
    const r = ws.getRow(i);
    const v: Record<string, Cell> = {};
    let any = false;
    for (const [key, k] of Object.entries(at)) {
      v[key] = cellValue(r.getCell(k).value);
      if (clean(v[key]) !== '') any = true;
    }
    if (any) out.push({ row: i, v });
  }
  return out;
}

export function readCatalogWorkbook(wb: ExcelJS.Workbook): CatalogSheets {
  const out: CatalogSheets = { products: null, brands: null, categories: null, substances: null, rules: null, missing: [] };
  const plain = (name: string, defs: ColumnDef[], optional: string[] = []) => {
    const ws = wb.getWorksheet(name);
    if (!ws) return null;
    const { at, missing } = mapColumns(ws.getRow(2), defs);
    const real = missing.filter((m) => !optional.includes(m));
    if (real.length) out.missing.push({ sheet: name, columns: real });
    return readRows(ws, at, FIRST_ROW, LAST_ROW);
  };
  out.products = plain(PRODUCTS_SHEET, PRODUCT_COLUMNS);
  out.brands = plain(BRANDS_SHEET, BRAND_COLUMNS);
  out.substances = plain(SUBSTANCES_SHEET, SUBSTANCE_COLUMNS);
  out.rules = plain(RULES_SHEET, RULE_COLUMNS);
  const cats = wb.getWorksheet(CATEGORIES_SHEET);
  if (cats) {
    // two blocks: «По потребности» (header row 2, rows 3–19) and «По типу» (header row 22, rows 23–39)
    out.categories = [];
    for (const [tree, head, from, to] of [
      ['need', 2, 3, 19],
      ['product_type', 22, 23, 39],
    ] as const) {
      const { at, missing } = mapColumns(cats.getRow(head), CATEGORY_COLUMNS);
      if (missing.length) out.missing.push({ sheet: `${CATEGORIES_SHEET} (строка ${head})`, columns: missing });
      out.categories.push(...readRows(cats, at, from, to).map((r) => ({ ...r, tree })));
    }
  }
  return out;
}

export async function readCatalogFile(file: string): Promise<CatalogSheets> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return readCatalogWorkbook(wb);
}

// ---------------- the database snapshot ----------------

export interface DbProduct {
  id: string;
  sku: string;
  status: string;
  /** values as the sheet shows them (the export writes exactly these) */
  cells: Record<string, Cell>;
  /** all active needs (the sheet has room for three) */
  needs: string[];
  substances: string[];
}

export interface DbBrand {
  id: string;
  name: string;
  status: string;
  products: number;
  cells: Record<string, Cell>;
}

export interface DbCategory {
  id: string;
  slug: string;
  tree: 'need' | 'product_type';
  name_ru: string;
  name_uz: string;
  status: string;
  sort_order: number;
  parent: string | null;
  merged_into: string | null;
  products: number;
}

export interface DbSubstance {
  id: string;
  code: string;
  kind: string;
  name_ru: string;
  name_uz: string;
  synonyms: string[];
  parent: string | null;
  enabled: boolean;
  sort_order: number;
  products: number;
  rules: number;
}

export interface DbRule {
  id: string;
  a: string;
  b: string;
  kind: string;
  interval_hours: number | null;
  when_a: string | null;
  when_b: string | null;
  text_ru: string;
  text_uz: string;
  source: string | null;
  origin: string;
  status: string;
}

export interface CatalogDb {
  products: DbProduct[];
  brands: DbBrand[];
  categories: DbCategory[];
  substances: DbSubstance[];
  rules: DbRule[];
}

const fileName = (url: string | null | undefined) => (url ? url.split(/[\\/]/).pop() ?? '' : '');
const yesNo = (b: boolean) => (b ? YES : NO);
const num = (v: bigint | number | null | undefined): number | null => (v == null ? null : Number(v));

/** The shell of the database as the list writes it («без капсулы» → «Без капсулы»); other values stay as they are. */
const shellCell = (s: string | null) => (s ? LISTS.shells.find((x) => lc(x) === lc(s)) ?? s : null);

/** Everything the table shows, in one READ ONLY transaction: nothing can be written by mistake. */
export async function loadCatalogDb(prisma: PrismaService): Promise<CatalogDb> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const cats = await tx.categories.findMany({ include: { parent: { select: { slug: true } }, merged_into: { select: { slug: true } }, _count: { select: { products: { where: { product: { status: { not: 'archived' } } } } } } } });
    const subs = await tx.substances.findMany({ include: { parent: { select: { code: true } }, _count: { select: { products: true, rules_a: true, rules_b: true } } }, orderBy: [{ sort_order: 'asc' }, { code: 'asc' }] });
    const codeOf = new Map(subs.map((s) => [s.id, s.code]));
    const rules = await tx.compat_rules.findMany({ orderBy: [{ created_at: 'asc' }, { id: 'asc' }] });
    const brands = await tx.brands.findMany({ include: { _count: { select: { products: { where: { status: { not: 'archived' } } } } } }, orderBy: [{ sort_order: 'asc' }, { name_ru: 'asc' }] });
    const products = await tx.products.findMany({
      where: { status: { not: 'archived' } },
      include: {
        brand_entry: { select: { name_ru: true } },
        manufacturer_entry: { select: { name_ru: true } },
        country_entry: { select: { name_ru: true } },
        form_entry: { select: { name_ru: true } },
        categories: { include: { category: true } },
        media: { where: { media_type: 'image' }, orderBy: [{ is_main: 'desc' }, { sort_order: 'asc' }] },
        substances: { include: { substance: { select: { code: true, name_ru: true, sort_order: true } } } },
      },
      orderBy: { sku: 'asc' },
    });
    const active = (tree: 'need' | 'product_type') =>
      cats.filter((c) => c.tree_type === tree && c.status === 'active').sort((a, b) => a.sort_order - b.sort_order || a.name_ru.localeCompare(b.name_ru));
    const needRank = new Map(active('need').map((c, i) => [c.id, i]));
    return {
      categories: cats.map((c) => ({
        id: c.id,
        slug: c.slug,
        tree: c.tree_type,
        name_ru: c.name_ru,
        name_uz: c.name_uz,
        status: c.status,
        sort_order: c.sort_order,
        parent: c.parent?.slug ?? null,
        merged_into: c.merged_into?.slug ?? null,
        products: c._count.products,
      })),
      substances: subs.map((s) => ({
        id: s.id,
        code: s.code,
        kind: s.kind,
        name_ru: s.name_ru,
        name_uz: s.name_uz,
        synonyms: s.synonyms,
        parent: s.parent?.code ?? null,
        enabled: s.enabled,
        sort_order: s.sort_order,
        products: s._count.products,
        rules: s._count.rules_a + s._count.rules_b,
      })),
      rules: rules.map((r) => ({
        id: r.id,
        a: codeOf.get(r.substance_a_id) ?? r.substance_a_id,
        b: codeOf.get(r.substance_b_id) ?? r.substance_b_id,
        kind: r.kind,
        interval_hours: r.interval_hours,
        when_a: r.when_a,
        when_b: r.when_b,
        text_ru: r.text_ru,
        text_uz: r.text_uz,
        source: r.source,
        origin: r.origin,
        status: r.status,
      })),
      brands: brands.map((b) => ({
        id: b.id,
        name: b.name_ru,
        status: b.status,
        products: b._count.products,
        cells: {
          name: b.name_ru,
          country_ru: b.country_ru,
          country_uz: b.country_uz,
          why_ru: b.why_vitalo_ru,
          why_uz: b.why_vitalo_uz,
          show: yesNo(b.show_in_showcase),
          order: b.sort_order,
          logo: fileName(b.logo_url) || null,
        },
      })),
      products: products.map((p) => {
        const needs = p.categories
          .map((pc) => pc.category)
          .filter((c) => c.tree_type === 'need' && needRank.has(c.id))
          .sort((a, b) => needRank.get(a.id)! - needRank.get(b.id)!)
          .map((c) => c.name_ru);
        const type = p.categories.map((pc) => pc.category).find((c) => c.tree_type === 'product_type' && c.status === 'active');
        const subsSorted = p.substances.map((s) => s.substance).sort((a, b) => a.sort_order - b.sort_order);
        return {
          id: p.id,
          sku: p.sku,
          status: p.status,
          needs,
          substances: subsSorted.map((s) => s.code),
          cells: {
            sku: p.sku,
            status: PRODUCT_STATUS[p.status] ?? p.status,
            brand: p.brand_entry?.name_ru ?? p.brand,
            name_ru: p.name_ru,
            name_uz: p.name_uz,
            short_ru: p.short_name_ru,
            short_uz: p.short_name_uz,
            need1: needs[0] ?? null,
            need2: needs[1] ?? null,
            need3: needs[2] ?? null,
            type: type?.name_ru ?? null,
            sform_ru: p.substance_form_ru,
            sform_uz: p.substance_form_uz,
            form: p.form_entry?.name_ru ?? p.form,
            pack: p.pack_count,
            per_day: p.servings_per_day,
            price: num(p.price_uzs),
            cost: num(p.cost_uzs),
            market: p.market_advantage_percent,
            desc_ru: p.short_description_ru,
            desc_uz: p.short_description_uz,
            comp_ru: p.composition_ru,
            comp_uz: p.composition_uz,
            dir_ru: p.directions_ru,
            dir_uz: p.directions_uz,
            warn_ru: p.warnings_ru,
            warn_uz: p.warnings_uz,
            verdict_ru: p.doctor_verdict_ru,
            verdict_uz: p.doctor_verdict_uz,
            memo_ru: p.intake_memo_ru,
            memo_uz: p.intake_memo_uz,
            substances: subsSorted.map((s) => s.name_ru).join(', ') || null,
            std_bio: yesNo(p.std_bioavailability),
            std_tested: yesNo(p.std_tested),
            std_orig: yesNo(p.std_original),
            halal: HALAL[p.halal_vege ?? 'unknown'] ?? p.halal_vege,
            shell: shellCell(p.shell_ru),
            halal_src: p.halal_vege_source,
            manufacturer: p.manufacturer_entry?.name_ru ?? p.manufacturer,
            country: p.country_entry?.name_ru ?? p.country,
            weight: p.shipping_weight_g,
            photos: p.media.map((m) => fileName(m.url)).filter(Boolean).join(', ') || null,
          },
        };
      }),
    };
  });
}

// ---------------- the dictionary of substances as the table will have it ----------------

export interface DictItem {
  /** existing code, or the code a new substance will get */
  code: string;
  name_ru: string;
  name_uz: string;
  kind: string;
  parent: string | null;
  synonyms: string[];
  enabled: boolean;
  order: number | null;
  row: number | null;
  isNew: boolean;
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Code of a new substance from its name: «Коэнзим Q10» → koenzim_q10 (a number is added when taken). */
export function codeFromName(name: string, taken: Set<string>): string {
  const base =
    lc(name)
      .split('')
      .map((ch) => TRANSLIT[ch] ?? ch)
      .join('')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'substance';
  let code = base;
  for (let n = 2; taken.has(code); n++) code = `${base}_${n}`;
  return code;
}

/** Every way to name a substance (name RU / UZ, synonyms, the code) → its code. */
export function dictLookup(dict: DictItem[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of dict) for (const s of [d.code, d.name_ru, d.name_uz, ...d.synonyms]) if (s && !map.has(lc(s))) map.set(lc(s), d.code);
  return map;
}

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** Up to three closest names of the dictionary: «Магнии» → «Магний». */
export function closestSubstances(text: string, dict: DictItem[], limit = 3): string[] {
  const t = lc(text);
  const scored = dict.map((d) => {
    const names = [d.name_ru, d.name_uz, d.code, ...d.synonyms].filter(Boolean).map(lc);
    const best = Math.min(...names.map((n) => (t.length > 2 && (n.includes(t) || t.includes(n)) ? 0.5 : levenshtein(t, n) / Math.max(t.length, n.length, 1))));
    return { name: d.name_ru, best };
  });
  return scored
    .filter((s) => s.best <= 0.6)
    .sort((a, b) => a.best - b.best)
    .slice(0, limit)
    .map((s) => s.name);
}

/** «Магний, витамин B6» → codes; unknown names with hints. */
export function resolveSubstances(text: Cell, dict: DictItem[], lookup = dictLookup(dict)): { codes: string[]; unknown: { name: string; hints: string[] }[] } {
  const codes: string[] = [];
  const unknown: { name: string; hints: string[] }[] = [];
  for (const name of splitList(text)) {
    const code = lookup.get(lc(name));
    if (code) {
      if (!codes.includes(code)) codes.push(code);
    } else unknown.push({ name, hints: closestSubstances(name, dict) });
  }
  return { codes, unknown };
}

const unknownMessage = (u: { name: string; hints: string[] }) =>
  `«${u.name}» нет в справочнике веществ` + (u.hints.length ? ` — может быть: ${u.hints.map((h) => `«${h}»`).join(', ')}?` : ' — добавьте его на лист «Вещества» (строка «Новое») или в синонимы');

// ---------------- the check ----------------

export interface Issue {
  sheet: string;
  row: number | null;
  message: string;
}

export interface FieldChange {
  label: string;
  before: string;
  after: string;
}

export interface Change {
  sheet: string;
  row: number | null;
  /** SKU, brand, category, substance or pair of a rule */
  what: string;
  /** «Новый», «Изменить», «В архив», «Выключить», «Одобрить»… */
  action: string;
  fields: FieldChange[];
}

export interface CatalogCheck {
  errors: Issue[];
  warnings: Issue[];
  changes: Change[];
  /** UZ texts that Claude translates and the owner checks before loading */
  translate: Issue[];
  /** counts for the summary */
  rows: Record<string, number>;
}

const show = (v: Cell | undefined) => {
  const t = clean(v);
  return t === '' ? '—' : t;
};

/** Same value? Numbers compared as numbers, texts after `clean`. */
export function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na != null && nb != null && !Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return clean(a) === clean(b);
}

export function checkCatalog(sheets: CatalogSheets, db: CatalogDb): CatalogCheck {
  const out: CatalogCheck = { errors: [], warnings: [], changes: [], translate: [], rows: {} };
  for (const m of sheets.missing) out.errors.push({ sheet: m.sheet, row: 2, message: `нет столбцов: ${m.columns.join(', ')}` });

  const dict = checkSubstances(sheets, db, out);
  const lookup = dictLookup(dict);
  const categories = checkCategories(sheets, db, out);
  const brands = checkBrands(sheets, db, out);
  checkProducts(sheets, db, out, { dict, lookup, categories, brands });
  checkRules(sheets, db, out, { dict, lookup });
  return out;
}

// ---- «Вещества» ----

function checkSubstances(sheets: CatalogSheets, db: CatalogDb, out: CatalogCheck): DictItem[] {
  const S = SUBSTANCES_SHEET;
  const fromDb = (s: DbSubstance): DictItem => ({ code: s.code, name_ru: s.name_ru, name_uz: s.name_uz, kind: s.kind, parent: s.parent, synonyms: s.synonyms, enabled: s.enabled, order: s.sort_order, row: null, isNew: false });
  if (!sheets.substances) {
    out.warnings.push({ sheet: S, row: null, message: 'листа «Вещества» нет — вещества проверяются по базе' });
    return db.substances.map(fromDb);
  }
  out.rows[S] = sheets.substances.length;
  const byCode = new Map(db.substances.map((s) => [s.code, s]));
  const kindOf = new Map(Object.entries(SUBSTANCE_KIND).map(([k, v]) => [lc(v), k]));
  const taken = new Set(db.substances.map((s) => s.code));
  const dict: DictItem[] = [];
  const pending: { r: SheetRow; item: DictItem; action: string; old: DbSubstance | undefined; parentText: string }[] = [];
  const seen = new Set<string>();
  for (const r of sheets.substances) {
    const v = r.v;
    const action = clean(v.action) || (clean(v.code) ? SUBSTANCE_ACTION.same : SUBSTANCE_ACTION.create);
    const code = clean(v.code);
    const err = (m: string) => out.errors.push({ sheet: S, row: r.row, message: m });
    if (!Object.values(SUBSTANCE_ACTION).includes(action as never)) {
      err(`Действие «${action}» не из списка (${Object.values(SUBSTANCE_ACTION).join(' / ')})`);
      continue;
    }
    const old = code ? byCode.get(code) : undefined;
    if (action === SUBSTANCE_ACTION.create && old) {
      err(`код «${code}» уже есть в базе — для правки поставьте «Изменить»`);
      continue;
    }
    if (action !== SUBSTANCE_ACTION.create && !old) {
      err(code ? `кода «${code}» нет в базе — для нового вещества поставьте «Новое» и очистите код` : 'нет кода — для нового вещества поставьте «Новое»');
      continue;
    }
    if (code && seen.has(code)) {
      err(`код «${code}» встречается дважды`);
      continue;
    }
    const nameRu = clean(v.name_ru);
    const kindText = clean(v.kind);
    const kind = kindText ? kindOf.get(lc(kindText)) : old?.kind ?? 'substance';
    if (!nameRu) err('нет названия RU');
    const comma = splitList(nameRu).length > 1;
    if (comma) err('в названии запятая вне скобок — по запятой разделяются вещества у товара');
    if (!kind) err(`Вид «${kindText}» не из списка (${Object.values(SUBSTANCE_KIND).join(' / ')})`);
    if (!nameRu || comma || !kind) continue;
    const enabledText = clean(v.enabled);
    if (enabledText && enabledText !== YES && enabledText !== NO) err(`Включено: «${enabledText}» — нужно Да или Нет`);
    const order = toNumber(v.order);
    if (order != null && (Number.isNaN(order) || !Number.isInteger(order))) err(`Порядок «${clean(v.order)}» — нужно целое число`);
    const itemCode = old ? old.code : codeFromName(clean(v.name_uz) || nameRu, taken);
    taken.add(itemCode);
    seen.add(itemCode);
    const item: DictItem = {
      code: itemCode,
      name_ru: nameRu,
      name_uz: clean(v.name_uz),
      kind,
      parent: null,
      synonyms: splitList(v.synonyms),
      enabled: enabledText ? enabledText === YES : old?.enabled ?? true,
      order: order != null && !Number.isNaN(order) ? order : null,
      row: r.row,
      isNew: !old,
    };
    if (!item.name_uz) out.translate.push({ sheet: S, row: r.row, message: `«${nameRu}»: нет названия UZ — переведёт Claude, вы проверите` });
    dict.push(item);
    pending.push({ r, item, action, old, parentText: clean(v.parent) });
  }
  for (const s of db.substances) {
    if (!dict.some((d) => d.code === s.code)) {
      out.warnings.push({ sheet: S, row: null, message: `«${s.name_ru}» (${s.code}) есть в базе, но нет на листе — останется как есть` });
      dict.push(fromDb(s));
    }
  }
  // names and synonyms must point to one substance
  const owner = new Map<string, DictItem>();
  for (const d of dict) {
    for (const s of new Set([d.name_ru, d.name_uz, d.code, ...d.synonyms].filter(Boolean).map(lc))) {
      const other = owner.get(s);
      if (other && other.code !== d.code) out.errors.push({ sheet: S, row: d.row ?? other.row, message: `«${s}» — и у «${other.name_ru}», и у «${d.name_ru}»: одно название может быть только у одного вещества` });
      else owner.set(s, d);
    }
  }
  const lookup = dictLookup(dict);
  for (const { r, item, action, old, parentText } of pending) {
    const err = (m: string) => out.errors.push({ sheet: S, row: r.row, message: m });
    if (parentText) {
      const p = lookup.get(lc(parentText));
      if (!p) err(`«Форма какого вещества»: ${unknownMessage({ name: parentText, hints: closestSubstances(parentText, dict) })}`);
      else if (p === item.code) err('вещество не может быть формой самого себя');
      else item.parent = p;
    }
    if (item.kind === 'form' && !parentText) err('для вида «Форма вещества» укажите, форма какого вещества (например P-5-P → Витамин B6)');
    const fields: FieldChange[] = [];
    const cmp = (label: string, before: string, after: string) => before !== after && fields.push({ label, before: before || '—', after: after || '—' });
    const nameOf = (c: string | null) => (c ? dict.find((d) => d.code === c)?.name_ru ?? c : '');
    const syn = (list: string[]) => [...new Set(list.map(lc))].sort().join(', ');
    if (old) {
      cmp('Название RU', clean(old.name_ru), item.name_ru);
      cmp('Название UZ', clean(old.name_uz), item.name_uz);
      cmp('Вид', SUBSTANCE_KIND[old.kind] ?? old.kind, SUBSTANCE_KIND[item.kind]);
      cmp('Форма какого вещества', nameOf(old.parent), nameOf(item.parent));
      if (syn(old.synonyms) !== syn(item.synonyms)) {
        const was = new Set(old.synonyms.map(lc));
        const now = new Set(item.synonyms.map(lc));
        const add = [...now].filter((s) => !was.has(s));
        const del = [...was].filter((s) => !now.has(s));
        fields.push({ label: 'Синонимы', before: del.length ? `убрать: ${del.join(', ')}` : '—', after: add.length ? `добавить: ${add.join(', ')}` : '—' });
      }
      cmp('Включено', yesNo(old.enabled), yesNo(item.enabled));
      if (item.order != null) cmp('Порядок', String(old.sort_order), String(item.order));
    } else {
      fields.push({ label: 'Код', before: '—', after: item.code });
      fields.push({ label: 'Название RU / UZ', before: '—', after: `${item.name_ru} / ${item.name_uz || '(переведёт Claude)'}` });
      fields.push({ label: 'Вид', before: '—', after: SUBSTANCE_KIND[item.kind] });
      if (item.parent) fields.push({ label: 'Форма какого вещества', before: '—', after: nameOf(item.parent) });
      if (item.synonyms.length) fields.push({ label: 'Синонимы', before: '—', after: item.synonyms.join(', ') });
    }
    if (action === SUBSTANCE_ACTION.same) {
      if (fields.length) out.warnings.push({ sheet: S, row: r.row, message: `«${item.name_ru}»: в таблице не так, как в базе (${fields.map((f) => f.label).join(', ')}), но стоит «Без изменений» — не загрузится. Чтобы загрузить, поставьте «Изменить»` });
      continue;
    }
    if (action === SUBSTANCE_ACTION.change && !fields.length) {
      out.warnings.push({ sheet: S, row: r.row, message: `«${item.name_ru}»: стоит «Изменить», но отличий от базы нет` });
      continue;
    }
    out.changes.push({ sheet: S, row: r.row, what: item.name_ru, action, fields });
  }
  return dict;
}

// ---- «Категории» ----

interface CategoryNames {
  need: Set<string>;
  product_type: Set<string>;
}

function checkCategories(sheets: CatalogSheets, db: CatalogDb, out: CatalogCheck): CategoryNames | null {
  const S = CATEGORIES_SHEET;
  if (!sheets.categories) {
    out.errors.push({ sheet: S, row: null, message: 'нет листа «Категории»' });
    return null;
  }
  out.rows[S] = sheets.categories.length;
  const names: CategoryNames = { need: new Set(), product_type: new Set() };
  const bySlug = new Map(db.categories.map((c) => [c.slug, c]));
  const codes = new Map<string, { tree: string; name: string }>();
  for (const r of sheets.categories) if (clean(r.v.code)) codes.set(clean(r.v.code).toUpperCase(), { tree: r.tree, name: clean(r.v.name_ru) });
  const used = new Set<string>();
  for (const tree of ['need', 'product_type'] as const) {
    const rows = sheets.categories.filter((r) => r.tree === tree);
    const activeDb = db.categories.filter((c) => c.tree === tree && c.status === 'active' && !c.parent).sort((a, b) => a.sort_order - b.sort_order);
    for (const r of rows) {
      const v = r.v;
      const err = (m: string) => out.errors.push({ sheet: S, row: r.row, message: m });
      const nameRu = clean(v.name_ru);
      if (!nameRu) {
        err('нет названия RU');
        continue;
      }
      const slug = clean(v.slug);
      const old = slug ? bySlug.get(slug) : undefined;
      if (slug && !old) err(`адреса «${slug}» нет в базе — не меняйте столбец «Адрес»`);
      if (slug && used.has(slug)) err(`адрес «${slug}» встречается дважды`);
      used.add(slug);
      const showText = clean(v.show) || YES;
      if (showText !== YES && showText !== NO) err(`Показывать: «${showText}» — нужно Да или Нет`);
      const order = toNumber(v.order);
      if (order != null && (Number.isNaN(order) || !Number.isInteger(order))) err(`Порядок «${clean(v.order)}» — нужно целое число`);
      const merge = clean(v.merge).toUpperCase();
      const into = merge ? codes.get(merge) : undefined;
      if (merge && !into) err(`«Объединить с»: кода «${merge}» нет на листе`);
      else if (into && into.tree !== tree) err('объединять можно только категории одного блока');
      else if (merge && merge === clean(v.code).toUpperCase()) err('категория не может объединяться сама с собой');
      if (showText === YES && !merge) names[tree].add(lc(nameRu));
      if (!clean(v.name_uz)) out.translate.push({ sheet: S, row: r.row, message: `«${nameRu}»: нет названия UZ — переведёт Claude, вы проверите` });
      const fields: FieldChange[] = [];
      const cmp = (label: string, before: string, after: string) => before !== after && fields.push({ label, before: before || '—', after: after || '—' });
      if (old) {
        cmp('Название RU', clean(old.name_ru), nameRu);
        cmp('Название UZ', clean(old.name_uz), clean(v.name_uz));
        const rank = activeDb.findIndex((c) => c.id === old.id) + 1;
        if (order != null && !Number.isNaN(order) && rank > 0) cmp('Порядок', String(rank), String(order));
        cmp('Показывать', old.status === 'active' ? YES : NO, showText);
        if (into) fields.push({ label: 'Объединить с', before: '—', after: into.name });
        if (fields.length) out.changes.push({ sheet: S, row: r.row, what: nameRu, action: 'Изменить', fields });
      } else if (!slug) {
        out.changes.push({ sheet: S, row: r.row, what: nameRu, action: 'Новая', fields: [{ label: 'Категория', before: '—', after: `${nameRu} / ${clean(v.name_uz) || '(переведёт Claude)'}` }] });
      }
    }
    for (const c of activeDb) {
      if (!used.has(c.slug)) out.warnings.push({ sheet: S, row: null, message: `«${c.name_ru}» (${c.slug}) показывается в магазине, но нет на листе — останется как есть` });
    }
  }
  return names;
}

// ---- «Бренды» ----

function checkBrands(sheets: CatalogSheets, db: CatalogDb, out: CatalogCheck): Set<string> | null {
  const S = BRANDS_SHEET;
  if (!sheets.brands) {
    out.errors.push({ sheet: S, row: null, message: 'нет листа «Бренды»' });
    return null;
  }
  out.rows[S] = sheets.brands.length;
  const names = new Set<string>();
  const byName = new Map(db.brands.map((b) => [lc(b.name), b]));
  const seen = new Set<string>();
  for (const r of sheets.brands) {
    const v = r.v;
    const name = clean(v.name);
    const err = (m: string) => out.errors.push({ sheet: S, row: r.row, message: m });
    if (!name) {
      err('нет названия бренда');
      continue;
    }
    if (seen.has(lc(name))) err(`бренд «${name}» встречается дважды`);
    seen.add(lc(name));
    const action = clean(v.action) || ACTION.same;
    if (!Object.values(ACTION).includes(action as never)) {
      err(`Действие «${action}» не из списка (${Object.values(ACTION).join(' / ')})`);
      continue;
    }
    const old = byName.get(lc(name));
    if (action !== ACTION.archive) names.add(lc(name));
    if (action === ACTION.create && old) {
      err(`бренд «${name}» уже есть в базе — для правки поставьте «Изменить»`);
      continue;
    }
    if (action !== ACTION.create && !old) {
      err(`бренда «${name}» нет в базе — для нового поставьте «Новый»`);
      continue;
    }
    for (const k of ['why_ru', 'why_uz'] as const) if (clean(v[k]).length > 350) err(`«Почему в VITALO» ${k === 'why_ru' ? 'RU' : 'UZ'} длиннее 350 знаков (${clean(v[k]).length})`);
    const showText = clean(v.show);
    if (showText && showText !== YES && showText !== NO) err(`Показывать в витрине: «${showText}» — нужно Да или Нет`);
    const order = toNumber(v.order);
    if (order != null && (Number.isNaN(order) || !Number.isInteger(order))) err(`Порядок «${clean(v.order)}» — нужно целое число`);
    if (action === ACTION.create || action === ACTION.change) {
      if (!clean(v.why_ru)) err('нет текста «Почему в VITALO» RU');
      if (clean(v.why_ru) && !clean(v.why_uz)) out.translate.push({ sheet: S, row: r.row, message: `«${name}»: нет текста UZ — переведёт Claude, вы проверите` });
    }
    const fields: FieldChange[] = [];
    for (const d of BRAND_COLUMNS) {
      if (['name', 'action', 'comment'].includes(d.key)) continue;
      const before = old?.cells[d.key];
      if (!sameCell(before, v[d.key])) fields.push({ label: d.label, before: show(before), after: show(v[d.key]) });
    }
    if (action === ACTION.archive) {
      if (old!.products) err(`у бренда «${name}» ${old!.products} товаров не в архиве — сначала уберите или перенесите товары`);
      out.changes.push({ sheet: S, row: r.row, what: name, action, fields: [{ label: 'Статус', before: 'Активен', after: 'Архив' }] });
    } else if (action === ACTION.same) {
      if (fields.length) out.warnings.push({ sheet: S, row: r.row, message: `«${name}»: в таблице не так, как в базе (${fields.map((f) => f.label).join(', ')}), но стоит «Без изменений» — не загрузится. Чтобы загрузить, поставьте «Изменить»` });
    } else if (action === ACTION.change && !fields.length) {
      out.warnings.push({ sheet: S, row: r.row, message: `«${name}»: стоит «Изменить», но отличий от базы нет` });
    } else {
      out.changes.push({ sheet: S, row: r.row, what: name, action, fields });
    }
  }
  for (const b of db.brands) {
    if (b.products && b.status === 'active' && !seen.has(lc(b.name))) out.warnings.push({ sheet: S, row: null, message: `«${b.name}» (товаров: ${b.products}) есть в базе, но нет на листе — останется как есть` });
  }
  return names;
}

// ---- «Товары» ----

function checkProducts(
  sheets: CatalogSheets,
  db: CatalogDb,
  out: CatalogCheck,
  ctx: { dict: DictItem[]; lookup: Map<string, string>; categories: CategoryNames | null; brands: Set<string> | null },
) {
  const S = PRODUCTS_SHEET;
  if (!sheets.products) {
    out.errors.push({ sheet: S, row: null, message: 'нет листа «Товары»' });
    return;
  }
  out.rows[S] = sheets.products.length;
  const bySku = new Map(db.products.map((p) => [p.sku.toUpperCase(), p]));
  const label = new Map(PRODUCT_COLUMNS.map((c) => [c.key, c.label]));
  const nameOf = new Map(ctx.dict.map((d) => [d.code, d.name_ru]));
  const statusOf = new Map(Object.entries(PRODUCT_STATUS).map(([k, v]) => [lc(v), k]));
  const seen = new Set<string>();
  const noDb: Set<string> = new Set();
  for (const r of sheets.products) {
    const v = r.v;
    const sku = clean(v.sku).toUpperCase();
    const action = clean(v.action) || (sku ? ACTION.same : ACTION.create);
    const who = sku || clean(v.short_ru) || clean(v.name_ru) || `строка ${r.row}`;
    const errors: string[] = [];
    const err = (m: string) => errors.push(m);
    if (!Object.values(ACTION).includes(action as never)) {
      out.errors.push({ sheet: S, row: r.row, message: `${who}: Действие «${action}» не из списка (${Object.values(ACTION).join(' / ')})` });
      continue;
    }
    if (sku && seen.has(sku)) err(`артикул ${sku} встречается дважды`);
    if (sku) seen.add(sku);
    const old = sku ? bySku.get(sku) : undefined;
    if (action === ACTION.create && old) err(`артикул ${sku} уже есть в базе — для правки поставьте «Изменить»`);
    if (action !== ACTION.create && !old) err(sku ? `артикула ${sku} нет в базе (или товар в архиве) — для нового товара поставьте «Новый»` : 'нет артикула — для нового товара поставьте «Новый»');
    const editing = action === ACTION.create || action === ACTION.change;
    if (editing) for (const k of PRODUCT_REQUIRED) if (!clean(v[k])) err(`не заполнено обязательное поле «${label.get(k)}»`);

    // values must be from the lists of the file; an old value of the database that is not changed is not an error
    const inList = (k: string, list: string[]) => {
      const t = clean(v[k]);
      if (!t || list.some((x) => lc(x) === lc(t))) return;
      if (old && sameCell(old.cells[k], v[k])) out.warnings.push({ sheet: S, row: r.row, message: `${who}: ${label.get(k)} «${t}» — так в базе, но этого значения нет в списке; при правке выберите из списка` });
      else err(`${label.get(k)}: «${t}» не из списка`);
    };
    const status = clean(v.status);
    if (status && !statusOf.has(lc(status))) err(`Статус «${status}» не из списка (${Object.values(PRODUCT_STATUS).join(' / ')})`);
    inList('form', LISTS.forms);
    inList('unit', LISTS.units);
    inList('shell', LISTS.shells);
    inList('halal', Object.values(HALAL));
    inList('translate', LISTS.translate);
    for (const k of ['std_bio', 'std_tested', 'std_orig']) inList(k, [YES, NO]);
    if (ctx.brands && clean(v.brand) && !ctx.brands.has(lc(clean(v.brand)))) err(`бренда «${clean(v.brand)}» нет на листе «Бренды» — сначала добавьте его туда`);
    if (ctx.categories) {
      for (const k of ['need1', 'need2', 'need3']) if (clean(v[k]) && !ctx.categories.need.has(lc(clean(v[k])))) err(`${label.get(k)}: «${clean(v[k])}» нет среди показываемых потребностей листа «Категории»`);
      if (clean(v.type) && !ctx.categories.product_type.has(lc(clean(v.type)))) err(`Тип: «${clean(v.type)}» нет среди показываемых типов листа «Категории»`);
    }
    const needs = ['need1', 'need2', 'need3'].map((k) => clean(v[k])).filter(Boolean);
    if (new Set(needs.map(lc)).size !== needs.length) err('одна потребность указана дважды');
    for (const k of PRODUCT_NUMBERS) {
      const n = toNumber(v[k]);
      if (n != null && (Number.isNaN(n) || n < 0)) err(`${label.get(k)}: «${clean(v[k])}» — нужно число`);
    }
    const market = toNumber(v.market);
    if (market != null && !Number.isNaN(market) && market > 50) err('Выгоднее Маркета — не больше 50%');
    for (const k of ['short_ru', 'short_uz']) if (clean(v[k]).length > 40) err(`${label.get(k)} длиннее 40 знаков (${clean(v[k]).length})`);
    for (const k of ['verdict_ru', 'verdict_uz']) if (clean(v[k]).length > 350) err(`${label.get(k)} длиннее 350 знаков (${clean(v[k]).length})`);

    // active substances: every name must be in the dictionary
    const subs = resolveSubstances(v.substances, ctx.dict, ctx.lookup);
    for (const u of subs.unknown) err(`Действующие вещества: ${unknownMessage(u)}`);

    for (const m of errors) out.errors.push({ sheet: S, row: r.row, message: `${who}: ${m}` });
    if (errors.length) continue;

    if (clean(v.translate) === TRANSLATE || (editing && PRODUCT_TEXT_UZ.some((k) => clean(v[k.replace('_uz', '_ru')]) && !clean(v[k])))) {
      const empty = PRODUCT_TEXT_UZ.filter((k) => clean(v[k.replace('_uz', '_ru')]) && !clean(v[k])).map((k) => label.get(k));
      if (editing && empty.length) out.translate.push({ sheet: S, row: r.row, message: `${who}: переведёт Claude — ${empty.join(', ')}` });
    }
    for (const k of PRODUCT_NO_DB) if (clean(v[k])) noDb.add(label.get(k)!);

    // было → стало
    const fields: FieldChange[] = [];
    const base = old?.cells ?? {};
    for (const d of PRODUCT_COLUMNS) {
      const k = d.key;
      if (PRODUCT_SERVICE.includes(k) || PRODUCT_NO_DB.includes(k) || ['need1', 'need2', 'need3', 'substances'].includes(k)) continue;
      if (k === 'status' && !clean(v.status) && !old) continue;
      if (!sameCell(base[k], v[k])) fields.push({ label: d.label, before: show(base[k]), after: show(v[k]) });
    }
    // needs: the order does not matter; a fourth need of the database stays (the sheet has room for three)
    const dbNeeds = old?.needs ?? [];
    const sheetNeeds = needs.map(lc);
    const needsSame = dbNeeds.length > 3 ? sheetNeeds.every((n) => dbNeeds.map(lc).includes(n)) && sheetNeeds.length === 3 : [...dbNeeds.map(lc)].sort().join('|') === [...sheetNeeds].sort().join('|');
    if (!needsSame) fields.push({ label: 'Потребности', before: dbNeeds.join(', ') || '—', after: needs.join(', ') || '—' });
    const dbSubs = old?.substances ?? [];
    if ([...dbSubs].sort().join('|') !== [...subs.codes].sort().join('|')) {
      const add = subs.codes.filter((c) => !dbSubs.includes(c)).map((c) => nameOf.get(c) ?? c);
      const del = dbSubs.filter((c) => !subs.codes.includes(c)).map((c) => nameOf.get(c) ?? c);
      fields.push({ label: 'Действующие вещества', before: del.length ? `убрать: ${del.join(', ')}` : '—', after: add.length ? `добавить: ${add.join(', ')}` : '—' });
    }
    if (action === ACTION.same) {
      if (fields.length) out.warnings.push({ sheet: S, row: r.row, message: `${who}: в таблице не так, как в базе (${fields.map((f) => f.label).join(', ')}), но стоит «Без изменений» — не загрузится. Чтобы загрузить, поставьте «Изменить»` });
    } else if (action === ACTION.archive) {
      out.changes.push({ sheet: S, row: r.row, what: who, action, fields: [{ label: 'Статус', before: PRODUCT_STATUS[old!.status], after: 'Архив (не удаляется, в магазине не виден)' }] });
    } else if (action === ACTION.change && !fields.length) {
      out.warnings.push({ sheet: S, row: r.row, message: `${who}: стоит «Изменить», но отличий от базы нет` });
    } else {
      out.changes.push({ sheet: S, row: r.row, what: action === ACTION.create && !sku ? `${who} (артикул выдаст загрузка)` : who, action, fields });
    }
  }
  for (const p of db.products) {
    if (!seen.has(p.sku.toUpperCase())) {
      out.warnings.push({ sheet: S, row: null, message: `${p.sku} (${PRODUCT_STATUS[p.status]}) есть в базе, но нет на листе — останется как есть${EXCLUDED_SKUS.includes(p.sku) ? ' (решение владельца 02.11: в таблицу не включаем)' : ''}` });
    }
  }
  if (noDb.size) out.warnings.push({ sheet: S, row: null, message: `заполнены столбцы, для которых в базе пока нет полей (${[...noDb].join(', ')}) — они не загрузятся до добавляющей миграции (вопрос 76)` });
}

// ---- «Правила совместимости» ----

function checkRules(sheets: CatalogSheets, db: CatalogDb, out: CatalogCheck, ctx: { dict: DictItem[]; lookup: Map<string, string> }) {
  const S = RULES_SHEET;
  if (!sheets.rules) {
    out.errors.push({ sheet: S, row: null, message: 'нет листа «Правила совместимости»' });
    return;
  }
  out.rows[S] = sheets.rules.length;
  const byId = new Map(db.rules.map((r) => [r.id, r]));
  const pairOf = (a: string, b: string) => [a, b].sort().join('|');
  const dbPair = new Map(db.rules.map((r) => [pairOf(r.a, r.b), r]));
  const kindOf = new Map(Object.entries(RULE_KIND_LABELS).map(([k, l]) => [lc(l.ru), k as RuleKind]));
  const whenOf = new Map(Object.entries(WHEN_LABELS).map(([k, l]) => [lc(l.ru), k as When]));
  const nameOf = (c: string) => ctx.dict.find((d) => d.code === c)?.name_ru ?? c;
  const kindLabel = (k: string | null) => (k ? RULE_KIND_LABELS[k as RuleKind]?.ru ?? k : '');
  const whenLabel = (w: string | null) => (w ? WHEN_LABELS[w as When]?.ru ?? w : '');
  const seenIds = new Set<string>();
  const seenPairs = new Map<string, number>();
  for (const r of sheets.rules) {
    const v = r.v;
    const id = clean(v.id);
    const action = clean(v.action) || RULE_ACTION.same;
    const approveText = clean(v.approve);
    const errors: string[] = [];
    const err = (m: string) => errors.push(m);
    if (!Object.values(RULE_ACTION).includes(action as never)) {
      out.errors.push({ sheet: S, row: r.row, message: `Действие «${action}» не из списка (${Object.values(RULE_ACTION).join(' / ')})` });
      continue;
    }
    if (approveText && approveText !== YES && approveText !== NO) err(`Одобрить: «${approveText}» — нужно Да или Нет`);
    const approve = approveText === YES;
    const old = id ? byId.get(id) : undefined;
    if (action === RULE_ACTION.create && id) err('у нового правила код правила должен быть пустым (его выдаст загрузка)');
    if (action !== RULE_ACTION.create && !old) err(id ? `правила с кодом ${id} нет в базе — не меняйте столбец «Код правила»` : 'строка без кода правила — для нового правила поставьте «Новое»');
    if (id && seenIds.has(id)) err('код правила встречается дважды');
    if (id) seenIds.add(id);
    if (action === RULE_ACTION.off && approve) err('«Выключить» и «Одобрить: Да» вместе нельзя — выберите одно');

    const a = ctx.lookup.get(lc(clean(v.a)));
    const b = ctx.lookup.get(lc(clean(v.b)));
    for (const [k, code] of [
      ['a', a],
      ['b', b],
    ] as const) {
      if (!clean(v[k])) err(`не заполнено «Вещество ${k.toUpperCase()}»`);
      else if (!code) err(`Вещество ${k.toUpperCase()}: ${unknownMessage({ name: clean(v[k]), hints: closestSubstances(clean(v[k]), ctx.dict) })}`);
    }
    if (a && b && a === b) err('A и B — одно и то же вещество');
    const kind = kindOf.get(lc(clean(v.kind)));
    if (!clean(v.kind)) err('не заполнен «Тип связи»');
    else if (!kind) err(`Тип связи «${clean(v.kind)}» не из списка`);
    const whenA = clean(v.when_a) ? whenOf.get(lc(clean(v.when_a))) : null;
    const whenB = clean(v.when_b) ? whenOf.get(lc(clean(v.when_b))) : null;
    if (whenA === undefined) err(`Когда A: «${clean(v.when_a)}» не из списка (${Object.values(WHEN_LABELS).map((l) => l.ru).join(' / ')})`);
    if (whenB === undefined) err(`Когда B: «${clean(v.when_b)}» не из списка (${Object.values(WHEN_LABELS).map((l) => l.ru).join(' / ')})`);
    const interval = toNumber(v.interval);
    if (interval != null && (Number.isNaN(interval) || !Number.isInteger(interval) || interval < 1 || interval > 24)) err(`Интервал «${clean(v.interval)}» — целое число часов от 1 до 24`);
    if (!clean(v.text_ru)) err('нет объяснения RU');
    const pair = a && b ? pairOf(a, b) : null;
    const who = a && b ? `${nameOf(a)} + ${nameOf(b)}` : `${clean(v.a) || '?'} + ${clean(v.b) || '?'}`;
    if (pair) {
      if (seenPairs.has(pair)) err(`пара уже есть в строке ${seenPairs.get(pair)}`);
      seenPairs.set(pair, r.row);
      const other = dbPair.get(pair);
      if (other && other.id !== old?.id) err(`для этой пары в базе уже есть правило (код ${other.id}) — правьте его строку`);
    }
    for (const m of errors) out.errors.push({ sheet: S, row: r.row, message: `${who}: ${m}` });
    if (errors.length) continue;
    if (kind === 'spread' && interval == null) out.warnings.push({ sheet: S, row: r.row, message: `${who}: «Разнести по времени» без интервала — AI не назовёт часы` });
    if (!clean(v.text_uz)) out.translate.push({ sheet: S, row: r.row, message: `${who}: нет объяснения UZ — переведёт Claude, вы проверите` });

    const fields: FieldChange[] = [];
    const cmp = (label: string, before: string, after: string) => clean(before) !== clean(after) && fields.push({ label, before: clean(before) || '—', after: clean(after) || '—' });
    if (old) {
      // the stored rule keeps its A → B order: compare a swapped row in that order
      const swapped = old.a === b && old.b === a;
      const [sa, sb, wa, wb] = swapped ? [b!, a!, whenB, whenA] : [a!, b!, whenA, whenB];
      cmp('Вещество A', nameOf(old.a), nameOf(sa));
      cmp('Вещество B', nameOf(old.b), nameOf(sb));
      cmp('Тип связи', kindLabel(old.kind), kindLabel(kind!));
      cmp('Интервал, часов', old.interval_hours == null ? '' : String(old.interval_hours), interval == null ? '' : String(interval));
      cmp('Когда A', whenLabel(old.when_a), whenLabel(wa ?? null));
      cmp('Когда B', whenLabel(old.when_b), whenLabel(wb ?? null));
      cmp('Объяснение RU', old.text_ru, clean(v.text_ru));
      cmp('Объяснение UZ', old.text_uz, clean(v.text_uz));
      cmp('Источник', old.source ?? '', clean(v.source));
      if (clean(v.status) && lc(clean(v.status)) !== lc(RULE_STATUS[old.status] ?? old.status)) {
        out.warnings.push({ sheet: S, row: r.row, message: `${who}: столбец «Статус» не загружается (в базе: ${RULE_STATUS[old.status]}). Чтобы одобрить — «Одобрить: Да», выключить — «Действие: Выключить»` });
      }
    }
    const statusNow = old ? RULE_STATUS[old.status] : '—';
    if (action === RULE_ACTION.same) {
      if (fields.length) out.warnings.push({ sheet: S, row: r.row, message: `${who}: в таблице не так, как в базе (${fields.map((f) => f.label).join(', ')}), но стоит «Без изменений» — не загрузится. Чтобы загрузить, поставьте «Изменить»` });
      if (approve && old!.status !== 'approved') out.changes.push({ sheet: S, row: r.row, what: who, action: 'Одобрить', fields: [{ label: 'Статус', before: statusNow, after: RULE_STATUS.approved }] });
      continue;
    }
    if (action === RULE_ACTION.off) {
      if (old!.status === 'off') out.warnings.push({ sheet: S, row: r.row, message: `${who}: правило уже выключено` });
      else out.changes.push({ sheet: S, row: r.row, what: who, action, fields: [...fields, { label: 'Статус', before: statusNow, after: RULE_STATUS.off }] });
      continue;
    }
    if (action === RULE_ACTION.create) {
      fields.push(
        { label: 'Тип связи', before: '—', after: kindLabel(kind!) },
        ...(interval != null ? [{ label: 'Интервал, часов', before: '—', after: String(interval) }] : []),
        { label: 'Объяснение RU', before: '—', after: clean(v.text_ru) },
      );
    }
    const after = approve ? 'approved' : action === RULE_ACTION.create ? 'draft' : old!.status;
    if (!old || after !== old.status) fields.push({ label: 'Статус', before: statusNow, after: RULE_STATUS[after] });
    if (action === RULE_ACTION.change && !fields.length) {
      out.warnings.push({ sheet: S, row: r.row, message: `${who}: стоит «Изменить», но отличий от базы нет` });
      continue;
    }
    out.changes.push({ sheet: S, row: r.row, what: who, action: approve && action === RULE_ACTION.change ? 'Изменить и одобрить' : approve ? 'Новое, сразу одобрено' : action, fields });
  }
  for (const rule of db.rules) {
    if (!seenIds.has(rule.id)) out.warnings.push({ sheet: S, row: null, message: `правило «${nameOf(rule.a)} + ${nameOf(rule.b)}» (${RULE_STATUS[rule.status]}) есть в базе, но нет на листе — останется как есть` });
  }
}

// ---------------- the report ----------------

const cut = (s: string, n: number) => {
  const t = s.replace(/\n/g, ' ').replace(/\|/g, '/');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function formatCatalogCheck(c: CatalogCheck, opts: { width?: number } = {}): string {
  const w = opts.width ?? 90;
  const where = (i: Issue) => `${i.sheet}${i.row ? `, стр. ${i.row}` : ''}`;
  const lines: string[] = [];
  const rows = Object.entries(c.rows)
    .map(([s, n]) => `${s} — ${n}`)
    .join('; ');
  lines.push(`Строк в таблице: ${rows || '—'}.`);
  lines.push(`Ошибок: ${c.errors.length}. Изменений: ${c.changes.length}. Переводов UZ: ${c.translate.length}. Предупреждений: ${c.warnings.length}.`, '');
  if (c.errors.length) {
    lines.push(`## Ошибки — пока они есть, ничего не загружается (${c.errors.length})`, '');
    for (const e of c.errors) lines.push(`- ${where(e)}: ${e.message}`);
    lines.push('');
  }
  const sheets = [SUBSTANCES_SHEET, CATEGORIES_SHEET, BRANDS_SHEET, PRODUCTS_SHEET, RULES_SHEET];
  lines.push('## Было → стало', '');
  if (!c.changes.length) lines.push('Изменений нет: таблица совпадает с базой (или у строк стоит «Без изменений»).', '');
  for (const s of sheets) {
    const list = c.changes.filter((x) => x.sheet === s);
    if (!list.length) continue;
    lines.push(`### ${s} (${list.length})`, '', '| Стр. | Что | Действие | Поле | Было | Стало |', '| --- | --- | --- | --- | --- | --- |');
    for (const x of list) {
      x.fields.forEach((f, i) =>
        lines.push(`| ${i ? '' : x.row ?? ''} | ${i ? '' : cut(x.what, 50)} | ${i ? '' : x.action} | ${f.label} | ${cut(f.before, w)} | ${cut(f.after, w)} |`),
      );
    }
    lines.push('');
  }
  if (c.translate.length) {
    lines.push(`## Переводы UZ — Claude переведёт и покажет вам на проверку до загрузки (${c.translate.length})`, '');
    for (const t of c.translate) lines.push(`- ${where(t)}: ${t.message}`);
    lines.push('');
  }
  if (c.warnings.length) {
    lines.push(`## Предупреждения — загрузке не мешают (${c.warnings.length})`, '');
    for (const t of c.warnings) lines.push(`- ${where(t)}: ${t.message}`);
    lines.push('');
  }
  return lines.join('\n');
}
