/**
 * The database → docs/content/VITALO_catalog.xlsx (npm run catalog:export). The file itself is the template: its
 * look, the owner's columns that the database has no field for (Единица, Порция, EAN…), comments and the owner's brand
 * texts stay; the columns that come from the database are rewritten.
 *
 * - «Товары»: every product that is not archived (except EXCLUDED_SKUS), «Действие: Без изменений»; «Действующие
 *   вещества» = names of the dictionary; «Дней курса» — one formula per row.
 * - «Бренды»: the owner's rows stay as they are (question 75); a brand of the database with products and no row is added.
 * - «Категории»: column «Адрес» (slug) and the comment with the number of products; the list of hidden categories.
 * - «Вещества» (new) and «Правила совместимости» (with «Статус», «Действие», «Одобрить», «Код правила»): from the database.
 * - Drop-down lists are written again as plain list validations: ExcelJS loses Excel's own (x14) ones when it saves.
 */
import ExcelJS from 'exceljs';
import { RULE_KIND_LABELS, WHEN_LABELS, type RuleKind, type When } from '../compat/knowledge';
import {
  ACTION,
  BRANDS_SHEET,
  BRAND_COLUMNS,
  CATEGORIES_SHEET,
  CATEGORY_COLUMNS,
  EXCLUDED_SKUS,
  FIRST_ROW,
  HALAL,
  LAST_ROW,
  LISTS,
  LISTS_SHEET,
  NO,
  PRODUCTS_SHEET,
  PRODUCT_COLUMNS,
  PRODUCT_STATUS,
  RULES_SHEET,
  RULE_ACTION,
  RULE_COLUMNS,
  RULE_STATUS,
  SUBSTANCES_SHEET,
  SUBSTANCE_ACTION,
  SUBSTANCE_KIND,
  YES,
  cellValue,
  clean,
  mapColumns,
  type CatalogDb,
  type Cell,
} from './catalog-master';

const YELLOW = 'FFFFF4CC'; // filled or changed by the owner
const GREY = 'FFE8ECF2'; // system: do not change
const ORANGE = 'FFFBD5B5'; // a required cell is empty
const BORDER = { style: 'thin' as const, color: { argb: 'FFC9D1DC' } };
const BORDERS = { left: BORDER, right: BORDER, top: BORDER, bottom: BORDER };
const FONT = { size: 10, name: 'Arial' };

export interface ExportSummary {
  products: number;
  productsAdded: string[];
  brandsAdded: string[];
  categoriesAdded: string[];
  substances: number;
  rules: number;
}

const copyStyle = (from: ExcelJS.Cell, to: ExcelJS.Cell) => {
  to.style = JSON.parse(JSON.stringify(from.style ?? {}));
};

const dataStyle = (cell: ExcelJS.Cell, argb: string) => {
  cell.style = { font: { ...FONT }, border: BORDERS, alignment: { vertical: 'top', wrapText: true }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb } } };
};

type Validations = Record<string, ExcelJS.DataValidation>;
const validations = (ws: ExcelJS.Worksheet) => (ws as unknown as { dataValidations: { model: Validations } }).dataValidations.model;

/**
 * ExcelJS reads validations cell by cell and, when it saves, squeezes them into ranges by sorting addresses as text:
 * «B10» comes before «B4», and B4:B300 is written together with an overlapping B10:B300. So every validation is kept
 * as one range key (a key with «:» is written as it is).
 */
export function compactValidations(ws: ExcelJS.Worksheet) {
  const model = validations(ws);
  const groups = new Map<string, { col: number; rows: number[]; dv: ExcelJS.DataValidation }>();
  for (const [addr, dv] of Object.entries(model)) {
    if (addr.includes(':')) continue;
    const cell = ws.getCell(addr);
    const key = `${cell.col}|${JSON.stringify(dv)}`;
    const g = groups.get(key) ?? { col: Number(cell.col), rows: [], dv };
    g.rows.push(Number(cell.row));
    groups.set(key, g);
    delete model[addr];
  }
  for (const g of groups.values()) {
    g.rows.sort((a, b) => a - b);
    let start = g.rows[0];
    for (let i = 1; i <= g.rows.length; i++) {
      if (i < g.rows.length && g.rows[i] === g.rows[i - 1] + 1) continue;
      const L = ws.getColumn(g.col).letter;
      model[`${L}${start}:${L}${g.rows[i - 1]}`] = g.dv;
      start = g.rows[i];
    }
  }
}

/** A drop-down list for `range` («B4:B300»); validations of single cells inside it are replaced. */
export function setList(ws: ExcelJS.Worksheet, range: string, formula: string, opts: { warning?: boolean } = {}) {
  const model = validations(ws);
  const [a, b = a] = range.split(':');
  const from = ws.getCell(a);
  const to = ws.getCell(b);
  for (const key of Object.keys(model)) {
    const [k1, k2 = k1] = key.split(':');
    const c1 = ws.getCell(k1);
    const c2 = ws.getCell(k2);
    const inside = Number(c1.row) >= Number(from.row) && Number(c2.row) <= Number(to.row) && Number(c1.col) >= Number(from.col) && Number(c2.col) <= Number(to.col);
    if (inside) delete model[key];
  }
  model[`${a}:${b}`] = {
    type: 'list',
    allowBlank: true,
    formulae: [formula],
    showErrorMessage: true,
    errorStyle: opts.warning ? 'warning' : 'stop',
    errorTitle: 'Из списка',
    error: opts.warning ? 'Такого названия нет в списке. Если это синоним из листа «Вещества» — нажмите «Да».' : 'Выберите значение из списка',
  };
}

/** Orange fill when the row's action is one of `actions` and the cell is empty. */
function requiredWhen(ws: ExcelJS.Worksheet, colLetter: string, actionCol: string, actions: string[]) {
  const cond = actions.map((a) => `$${actionCol}${FIRST_ROW}="${a}"`).join(',');
  ws.addConditionalFormatting({
    ref: `${colLetter}${FIRST_ROW}:${colLetter}${LAST_ROW}`,
    rules: [{ type: 'expression', priority: 1, formulae: [`AND(OR(${cond}),${colLetter}${FIRST_ROW}="")`], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: ORANGE } } } }],
  });
}

const letter = (ws: ExcelJS.Worksheet, n: number) => ws.getColumn(n).letter;

/** «Дней курса» = pack ÷ (portion × servings per day); without a number in «Порция» — pack ÷ servings. */
const courseFormula = (P: string, R: string, S: string, row: number) => {
  const portion = `VALUE(LEFT(${R}${row},FIND(" ",${R}${row}&" ")-1))`;
  return `IF(AND(ISNUMBER(${P}${row}),ISNUMBER(${S}${row}),${S}${row}>0,ISNUMBER(${portion})),ROUNDDOWN(${P}${row}/(${S}${row}*${portion}),0),IF(AND(ISNUMBER(${P}${row}),ISNUMBER(${S}${row}),${S}${row}>0),ROUNDDOWN(${P}${row}/${S}${row},0),""))`;
};

function writeLists(wb: ExcelJS.Workbook) {
  const ws = wb.getWorksheet(LISTS_SHEET)!;
  const head = ws.getCell('A1');
  const column = (col: string, title: string, values: string[]) => {
    const h = ws.getCell(`${col}1`);
    h.value = title;
    copyStyle(head, h);
    for (let i = 0; i < 12; i++) ws.getCell(`${col}${i + 2}`).value = values[i] ?? null;
    ws.getColumn(col).width = 24;
  };
  column('A', 'Действие', Object.values(ACTION));
  column('B', 'Статус', [PRODUCT_STATUS.active, PRODUCT_STATUS.hidden, PRODUCT_STATUS.archived]);
  column('C', 'Форма выпуска', LISTS.forms);
  column('D', 'Единица', LISTS.units);
  column('E', 'Да/Нет', [YES, NO]);
  column('F', 'Halal/VEGE', [HALAL.halal, HALAL.vege, HALAL.halal_vege, HALAL.none, HALAL.unknown]);
  column('G', 'Оболочка', LISTS.shells);
  column('H', 'Перевод UZ', LISTS.translate);
  column('I', 'Тип связи', Object.values(RULE_KIND_LABELS).map((l) => l.ru));
  column('J', 'Время приёма', Object.values(WHEN_LABELS).map((l) => l.ru));
  column('K', 'Действие правила', Object.values(RULE_ACTION));
  column('L', 'Статус правила', Object.values(RULE_STATUS));
  column('M', 'Действие вещества', Object.values(SUBSTANCE_ACTION));
  column('N', 'Вид вещества', Object.values(SUBSTANCE_KIND));
}

/** `Справочники!$A$2:$A$5` for a column of the lists. */
const listRef = (col: string, n: number) => `${LISTS_SHEET}!$${col}$2:$${col}$${n + 1}`;

function writeProducts(wb: ExcelJS.Workbook, db: CatalogDb, sum: ExportSummary) {
  const ws = wb.getWorksheet(PRODUCTS_SHEET)!;
  const { at } = mapColumns(ws.getRow(2), PRODUCT_COLUMNS);
  const L = (k: string) => letter(ws, at[k]);
  const rowOf = new Map<string, number>();
  const noSku = new Map<string, number>();
  let last = FIRST_ROW - 1;
  for (let i = FIRST_ROW; i <= LAST_ROW; i++) {
    const sku = clean(cellValue(ws.getCell(i, at.sku).value)).toUpperCase();
    if (sku) rowOf.set(sku, i);
    else {
      // a row «Новый» of a product loaded by catalog:load: it gets its SKU here instead of a second row below
      const name = clean(cellValue(ws.getCell(i, at.name_ru).value)).toLowerCase();
      if (name && !noSku.has(name)) noSku.set(name, i);
    }
    if (PRODUCT_COLUMNS.some((c) => at[c.key] && c.key !== 'course' && clean(cellValue(ws.getCell(i, at[c.key]).value)))) last = i;
  }
  const products = db.products.filter((p) => !EXCLUDED_SKUS.includes(p.sku));
  for (const p of products) {
    const row = noSku.get(clean(p.cells.name_ru).toLowerCase());
    if (!rowOf.has(p.sku.toUpperCase()) && row) {
      rowOf.set(p.sku.toUpperCase(), row);
      noSku.delete(clean(p.cells.name_ru).toLowerCase());
    }
  }
  for (const p of products) {
    let row = rowOf.get(p.sku.toUpperCase());
    if (!row) {
      row = ++last;
      for (let c = 1; c <= ws.columnCount; c++) copyStyle(ws.getCell(FIRST_ROW, c), ws.getCell(row, c));
      sum.productsAdded.push(p.sku);
    }
    for (const [k, v] of Object.entries(p.cells)) if (at[k]) ws.getCell(row, at[k]).value = v as Cell;
    ws.getCell(row, at.action).value = ACTION.same;
    if (p.needs.length > 3) {
      const note = `В базе ещё потребность: ${p.needs.slice(3).join(', ')} (в таблице место только для трёх).`;
      const c = ws.getCell(row, at.comment);
      const now = clean(cellValue(c.value));
      if (!now.includes('В базе ещё потребност')) c.value = now ? `${now}\n${note}` : note;
    }
  }
  // one formula per row instead of a shared one (ExcelJS keeps shared formulas badly)
  for (let i = FIRST_ROW - 1; i <= LAST_ROW; i++) ws.getCell(i, at.course).value = { formula: courseFormula(L('pack'), L('portion'), L('per_day'), i) } as ExcelJS.CellFormulaValue;
  sum.products = products.length;

  setList(ws, `${L('action')}${FIRST_ROW}:${L('action')}${LAST_ROW}`, listRef('A', 4));
  setList(ws, `${L('status')}${FIRST_ROW}:${L('status')}${LAST_ROW}`, listRef('B', 3));
  setList(ws, `${L('brand')}${FIRST_ROW}:${L('brand')}${LAST_ROW}`, `${BRANDS_SHEET}!$A$${FIRST_ROW}:$A$${LAST_ROW}`);
  setList(ws, `${L('need1')}${FIRST_ROW}:${L('need3')}${LAST_ROW}`, `${CATEGORIES_SHEET}!$B$3:$B$19`);
  setList(ws, `${L('type')}${FIRST_ROW}:${L('type')}${LAST_ROW}`, `${CATEGORIES_SHEET}!$B$23:$B$39`);
  setList(ws, `${L('form')}${FIRST_ROW}:${L('form')}${LAST_ROW}`, listRef('C', LISTS.forms.length));
  setList(ws, `${L('unit')}${FIRST_ROW}:${L('unit')}${LAST_ROW}`, listRef('D', LISTS.units.length));
  setList(ws, `${L('std_bio')}${FIRST_ROW}:${L('std_orig')}${LAST_ROW}`, listRef('E', 2));
  setList(ws, `${L('halal')}${FIRST_ROW}:${L('halal')}${LAST_ROW}`, listRef('F', 5));
  setList(ws, `${L('shell')}${FIRST_ROW}:${L('shell')}${LAST_ROW}`, listRef('G', LISTS.shells.length));
  setList(ws, `${L('translate')}${FIRST_ROW}:${L('translate')}${LAST_ROW}`, listRef('H', LISTS.translate.length));
  const head = ws.getCell(2, at.substances);
  head.value = 'Действующие вещества для проверки совместимости\n(названия с листа «Вещества» через запятую)';
}

function writeBrands(wb: ExcelJS.Workbook, db: CatalogDb, sum: ExportSummary) {
  const ws = wb.getWorksheet(BRANDS_SHEET)!;
  const { at } = mapColumns(ws.getRow(2), BRAND_COLUMNS);
  const names = new Set<string>();
  const inDb = new Set(db.brands.map((b) => b.name.toLowerCase()));
  let last = FIRST_ROW - 1;
  for (let i = FIRST_ROW; i <= LAST_ROW; i++) {
    const n = clean(cellValue(ws.getCell(i, at.name).value));
    if (n) {
      names.add(n.toLowerCase());
      last = i;
      // a brand «Новый» that is in the database now (catalog:load): the next edit is «Изменить», not a second «Новый»
      if (inDb.has(n.toLowerCase()) && clean(cellValue(ws.getCell(i, at.action).value)) === ACTION.create) ws.getCell(i, at.action).value = ACTION.same;
    }
  }
  for (const b of db.brands) {
    if (!b.products || b.status !== 'active' || names.has(b.name.toLowerCase())) continue;
    const row = ++last;
    for (let c = 1; c <= ws.columnCount; c++) copyStyle(ws.getCell(FIRST_ROW, c), ws.getCell(row, c));
    for (const [k, v] of Object.entries(b.cells)) if (at[k]) ws.getCell(row, at[k]).value = v as Cell;
    ws.getCell(row, at.action).value = ACTION.same;
    ws.getCell(row, at.comment).value = `Добавлен при выгрузке: в базе товаров ${b.products}`;
    sum.brandsAdded.push(b.name);
  }
  setList(ws, `${letter(ws, at.action)}${FIRST_ROW}:${letter(ws, at.action)}${LAST_ROW}`, listRef('A', 4));
  setList(ws, `${letter(ws, at.show)}${FIRST_ROW}:${letter(ws, at.show)}${LAST_ROW}`, listRef('E', 2));
}

function writeCategories(wb: ExcelJS.Workbook, db: CatalogDb, sum: ExportSummary, date: string) {
  const ws = wb.getWorksheet(CATEGORIES_SHEET)!;
  const blocks = [
    { tree: 'need' as const, head: 2, from: 3, to: 19, prefix: 'N' },
    { tree: 'product_type' as const, head: 22, from: 23, to: 39, prefix: 'T' },
  ];
  for (const b of blocks) {
    const h = ws.getCell(b.head, 8);
    h.value = 'Адрес (slug)\n(не менять)';
    copyStyle(ws.getCell(b.head, 1), h);
    const { at } = mapColumns(ws.getRow(b.head), CATEGORY_COLUMNS);
    const top = db.categories.filter((c) => c.tree === b.tree && !c.parent);
    const active = top.filter((c) => c.status === 'active').sort((x, y) => x.sort_order - y.sort_order);
    const seen = new Set<string>();
    let lastRow = b.from - 1;
    for (let i = b.from; i <= b.to; i++) {
      const name = clean(cellValue(ws.getCell(i, at.name_ru).value));
      if (!name) continue;
      lastRow = i;
      const c = top.find((x) => x.slug === clean(cellValue(ws.getCell(i, at.slug).value))) ?? top.find((x) => x.name_ru.toLowerCase() === name.toLowerCase());
      if (!c) continue;
      seen.add(c.slug);
      ws.getCell(i, at.slug).value = c.slug;
      copyStyle(ws.getCell(i, at.code), ws.getCell(i, at.slug));
      ws.getCell(i, at.comment).value = `В базе: товаров не в архиве ${c.products}`;
    }
    for (const c of active) {
      if (seen.has(c.slug)) continue;
      const row = ++lastRow;
      for (let k = 1; k <= 8; k++) copyStyle(ws.getCell(b.from, k), ws.getCell(row, k));
      ws.getCell(row, at.code).value = `${b.prefix}${row - b.from + 1}`;
      ws.getCell(row, at.name_ru).value = c.name_ru;
      ws.getCell(row, at.name_uz).value = c.name_uz;
      ws.getCell(row, at.order).value = active.indexOf(c) + 1;
      ws.getCell(row, at.show).value = YES;
      ws.getCell(row, at.slug).value = c.slug;
      ws.getCell(row, at.comment).value = `Добавлена при выгрузке; в базе: товаров не в архиве ${c.products}`;
      sum.categoriesAdded.push(c.name_ru);
    }
    setList(ws, `E${b.from}:E${b.to}`, listRef('E', 2));
  }
  ws.getColumn(8).width = 16;
  // reference list of hidden categories (below the blocks)
  const title = ws.getCell('A42');
  title.value = `Скрытые категории в базе (для справки, в выпадающие списки не входят; выгрузка ${date}):`;
  const hidden = db.categories
    .filter((c) => c.status !== 'active')
    .sort((x, y) => (x.tree === y.tree ? (x.parent ?? '').localeCompare(y.parent ?? '') || x.sort_order - y.sort_order : x.tree === 'need' ? -1 : 1));
  const nameOf = (slug: string | null) => db.categories.find((c) => c.slug === slug)?.name_ru ?? slug;
  for (let i = 43; i <= 70; i++) for (let k = 1; k <= 8; k++) ws.getCell(i, k).value = null;
  hidden.forEach((c, i) => {
    const row = 43 + i;
    ws.getCell(row, 1).value = c.tree === 'need' ? 'Потребность' : 'Тип';
    ws.getCell(row, 2).value = c.name_ru;
    ws.getCell(row, 3).value = c.name_uz;
    ws.getCell(row, 5).value = NO;
    ws.getCell(row, 6).value = c.merged_into ? `Объединена с: ${nameOf(c.merged_into)}` : null;
    ws.getCell(row, 7).value = c.products ? `к ней всё ещё привязано товаров: ${c.products}` : null;
    ws.getCell(row, 8).value = c.slug;
  });
}

function writeSubstances(wb: ExcelJS.Workbook, db: CatalogDb, sum: ExportSummary) {
  const rules = wb.getWorksheet(RULES_SHEET)!;
  const old = wb.getWorksheet(SUBSTANCES_SHEET);
  if (old) wb.removeWorksheet(old.id);
  const ws = wb.addWorksheet(SUBSTANCES_SHEET, { views: [{ state: 'frozen', xSplit: 0, ySplit: 3 }] });
  // between «Бренды» and «Правила совместимости»
  const order = wb.worksheets.filter((w) => w !== ws);
  order.splice(order.indexOf(rules), 0, ws);
  order.forEach((w, i) => ((w as unknown as { orderNo: number }).orderNo = i));

  const groups: [string, number, number][] = [
    ['Вещество', 1, 5],
    ['Как его узнать', 6, 7],
    ['Загрузка', 8, 10],
  ];
  const heads = [
    'Код\n(не менять; пусто для нового)',
    'Действие',
    'Название RU\n(как в магазине и в ответе AI)',
    'Название UZ',
    'Вид',
    'Форма какого вещества\n(только для вида «Форма вещества»)',
    'Синонимы\n(через запятую: как пишут на этикетке, RU / UZ / EN)',
    'Включено',
    'Порядок',
    'Комментарий',
  ];
  groups.forEach(([title, from, to], g) => {
    ws.mergeCells(1, from, 1, to);
    const c = ws.getCell(1, from);
    c.value = title;
    copyStyle(rules.getCell(1, [1, 3, 7][g]), c);
  });
  heads.forEach((h, i) => {
    const c = ws.getCell(2, i + 1);
    c.value = h;
    copyStyle(rules.getCell('A2'), c);
  });
  ws.getRow(2).height = 57.75;
  const example = ['', SUBSTANCE_ACTION.create, 'Коэнзим Q10 (ПРИМЕР)', 'Koenzim Q10', SUBSTANCE_KIND.substance, '', 'коэнзим q10, убихинон, coq10, coenzyme q10', YES, 400, 'Пример — не загружается'];
  example.forEach((v, i) => {
    const c = ws.getCell(3, i + 1);
    c.value = v === '' ? null : v;
    copyStyle(rules.getCell('A3'), c);
  });
  const nameOf = new Map(db.substances.map((s) => [s.code, s.name_ru]));
  for (let row = FIRST_ROW; row <= LAST_ROW; row++) for (let k = 1; k <= heads.length; k++) dataStyle(ws.getCell(row, k), k === 1 ? GREY : YELLOW);
  db.substances.forEach((s, i) => {
    const row = FIRST_ROW + i;
    const values: Cell[] = [
      s.code,
      SUBSTANCE_ACTION.same,
      s.name_ru,
      s.name_uz,
      SUBSTANCE_KIND[s.kind] ?? s.kind,
      s.parent ? nameOf.get(s.parent) ?? s.parent : null,
      s.synonyms.join(', '),
      s.enabled ? YES : NO,
      s.sort_order,
      `Товаров: ${s.products}, правил: ${s.rules}`,
    ];
    values.forEach((v, k) => (ws.getCell(row, k + 1).value = v));
  });
  sum.substances = db.substances.length;
  [18, 15, 30, 30, 17, 26, 60, 10, 9, 22].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  setList(ws, `B${FIRST_ROW}:B${LAST_ROW}`, listRef('M', 3));
  setList(ws, `E${FIRST_ROW}:E${LAST_ROW}`, listRef('N', 3));
  setList(ws, `F${FIRST_ROW}:F${LAST_ROW}`, `${SUBSTANCES_SHEET}!$C$${FIRST_ROW}:$C$${LAST_ROW}`, { warning: true });
  setList(ws, `H${FIRST_ROW}:H${LAST_ROW}`, listRef('E', 2));
  for (const c of ['C', 'D', 'E']) requiredWhen(ws, c, 'B', [SUBSTANCE_ACTION.create, SUBSTANCE_ACTION.change]);
}

function writeRules(wb: ExcelJS.Workbook, db: CatalogDb, sum: ExportSummary) {
  const ws = wb.getWorksheet(RULES_SHEET)!;
  const extra: [string, string, number, string][] = [
    ['J', 'Статус сейчас\n(в базе, не менять)', 13, GREY],
    ['K', 'Действие', 15, YELLOW],
    ['L', 'Одобрить\n(Да — AI начнёт им пользоваться)', 13, YELLOW],
    ['M', 'Код правила\n(не менять; пусто для нового)', 38, GREY],
  ];
  if (!ws.getCell('J1').isMerged) ws.mergeCells('J1:M1');
  ws.getCell('J1').value = 'Загрузка';
  copyStyle(ws.getCell('A1'), ws.getCell('J1'));
  for (const [c, title, width] of extra) {
    ws.getCell(`${c}2`).value = title;
    copyStyle(ws.getCell('A2'), ws.getCell(`${c}2`));
    ws.getColumn(c).width = width;
    copyStyle(ws.getCell('A3'), ws.getCell(`${c}3`));
  }
  ws.getCell('J3').value = RULE_STATUS.draft;
  ws.getCell('K3').value = RULE_ACTION.create;
  ws.getCell('L3').value = NO;
  ws.getCell('B2').value = 'Вещество B\n(название с листа «Вещества»)';
  ws.getCell('A2').value = 'Вещество A\n(название с листа «Вещества»)';
  const nameOf = new Map(db.substances.map((s) => [s.code, s.name_ru]));
  for (let row = FIRST_ROW; row <= LAST_ROW; row++) {
    for (let k = 1; k <= 13; k++) {
      const c = ws.getCell(row, k);
      c.value = null;
      dataStyle(c, k === 10 || k === 13 ? GREY : YELLOW);
    }
  }
  db.rules.forEach((r, i) => {
    const row = FIRST_ROW + i;
    const values: Cell[] = [
      nameOf.get(r.a) ?? r.a,
      nameOf.get(r.b) ?? r.b,
      RULE_KIND_LABELS[r.kind as RuleKind]?.ru ?? r.kind,
      r.interval_hours,
      r.when_a ? WHEN_LABELS[r.when_a as When]?.ru ?? r.when_a : null,
      r.when_b ? WHEN_LABELS[r.when_b as When]?.ru ?? r.when_b : null,
      r.text_ru,
      r.text_uz,
      r.source,
      RULE_STATUS[r.status] ?? r.status,
      RULE_ACTION.same,
      NO,
      r.id,
    ];
    values.forEach((v, k) => (ws.getCell(row, k + 1).value = v));
  });
  sum.rules = db.rules.length;
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 3 }];
  setList(ws, `A${FIRST_ROW}:B${LAST_ROW}`, `${SUBSTANCES_SHEET}!$C$${FIRST_ROW}:$C$${LAST_ROW}`, { warning: true });
  setList(ws, `C${FIRST_ROW}:C${LAST_ROW}`, listRef('I', 4));
  setList(ws, `E${FIRST_ROW}:F${LAST_ROW}`, listRef('J', 6));
  setList(ws, `K${FIRST_ROW}:K${LAST_ROW}`, listRef('K', 4));
  setList(ws, `L${FIRST_ROW}:L${LAST_ROW}`, listRef('E', 2));
  for (const c of ['A', 'B', 'C', 'G']) requiredWhen(ws, c, 'K', [RULE_ACTION.create, RULE_ACTION.change]);
}

const INSTRUCTION: [string, string][] = [
  ['1. Выгрузка', 'Claude Code заполняет листы «Товары», «Бренды», «Категории», «Вещества» и «Правила совместимости» данными из базы (npm run catalog:export). Из базы только читает.'],
  ['2. Ваши правки', 'Действующий товар: меняете нужные ячейки и ставите «Действие: Изменить». Новый товар: строка внизу, артикул пустой, «Действие: Новый». Убрать: «В архив» (товар не удаляется). Остальным — «Без изменений»: такие строки не загружаются, даже если в них что-то поменяли.'],
  ['5. Загрузка', 'Скажите Claude Code «загружай». Он запустит проверку (npm run catalog:check — в базу ничего не пишет): покажет ошибки, переводы UZ на проверку и таблицу «было → стало». Записывает только после вашего «да»: сначала на ноутбук, потом на сервер вместе с выкладкой и с бэкапом.'],
];

const INSTRUCTION_MORE: [string, string][] = [
  ['Вещества', 'Справочник веществ для VITALO AI: название RU / UZ, вид (вещество, форма вещества, группа лекарств) и синонимы — как вещество пишут на этикетках. Новое вещество — строка внизу, код пустой, «Действие: Новое». Код не меняйте.'],
  ['Действующие вещества', 'Лист «Товары», столбец «Действующие вещества»: названия с листа «Вещества» через запятую (можно синоним). Неизвестное название — ошибка при проверке, с подсказкой похожих.'],
  ['Правила: Действие', '«Без изменений», «Изменить», «Новое» (код правила пустой) или «Выключить» — правило не удаляется, VITALO AI просто перестаёт его видеть.'],
  ['Правила: Одобрить', '«Да» — при загрузке правило станет «Одобрено» и VITALO AI начнёт им пользоваться (вы — администратор). Можно вместе с «Изменить» или при «Без изменений». Столбец «Статус сейчас» показывает базу — его не меняйте.'],
];

function writeInstruction(wb: ExcelJS.Workbook) {
  const ws = wb.getWorksheet('Инструкция');
  if (!ws) return;
  for (let i = 1; i <= ws.rowCount; i++) {
    const key = clean(cellValue(ws.getCell(i, 2).value));
    const hit = INSTRUCTION.find(([k]) => k === key);
    if (hit) ws.getCell(i, 3).value = hit[1];
    if (key === 'Правила совместимости') ws.getCell(i, 3).value = 'Лист для VITALO AI (подэтап 3.8): правила из базы со статусом. AI видит только одобренные правила. Можно править, добавлять и выключать.';
  }
  let row = ws.rowCount;
  const known = new Set(Array.from({ length: row }, (_, i) => clean(cellValue(ws.getCell(i + 1, 2).value))));
  for (const [k, text] of INSTRUCTION_MORE) {
    if (known.has(k)) continue;
    row++;
    ws.getCell(row, 2).value = k;
    ws.getCell(row, 3).value = text;
    copyStyle(ws.getCell(24, 2), ws.getCell(row, 2));
    copyStyle(ws.getCell(24, 3), ws.getCell(row, 3));
  }
}

export async function writeCatalogWorkbook(template: string, out: string, db: CatalogDb, date: string): Promise<ExportSummary> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(template);
  const sum: ExportSummary = { products: 0, productsAdded: [], brandsAdded: [], categoriesAdded: [], substances: 0, rules: 0 };
  wb.worksheets.forEach(compactValidations);
  writeLists(wb);
  writeProducts(wb, db, sum);
  writeBrands(wb, db, sum);
  writeCategories(wb, db, sum, date);
  writeSubstances(wb, db, sum);
  writeRules(wb, db, sum);
  writeInstruction(wb);
  wb.calcProperties = { ...wb.calcProperties, fullCalcOnLoad: true };
  // open on «Инструкция», one sheet selected (several selected sheets are edited together in Excel)
  wb.views = [{ x: 0, y: 0, width: 21795, height: 12975, firstSheet: 0, activeTab: 0, visibility: 'visible' }];
  wb.worksheets.forEach((w, i) => (w.views ?? []).forEach((v) => ((v as { tabSelected?: boolean }).tabSelected = i === 0)));
  await wb.xlsx.writeFile(out);
  return sum;
}
