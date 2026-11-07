import ExcelJS from 'exceljs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BRAND_COLUMNS,
  CATEGORY_COLUMNS,
  PRODUCT_COLUMNS,
  RULE_COLUMNS,
  checkCatalog,
  closestSubstances,
  codeFromName,
  formatCatalogCheck,
  readCatalogFile,
  resolveSubstances,
  splitList,
  type CatalogDb,
  type CatalogSheets,
  type DictItem,
  type SheetRow,
} from './catalog-master';
import { writeCatalogWorkbook } from './catalog-master-export';

const sub = (code: string, name_ru: string, name_uz: string, synonyms: string[], extra: Partial<CatalogDb['substances'][number]> = {}) => ({
  id: `id-${code}`,
  code,
  kind: 'substance',
  name_ru,
  name_uz,
  synonyms,
  parent: null,
  enabled: true,
  sort_order: 0,
  products: 0,
  rules: 0,
  ...extra,
});

const DB: CatalogDb = {
  substances: [
    sub('magnesium', 'Магний', 'Magniy', ['магний', 'цитрат магния', 'magnesium'], { sort_order: 100 }),
    sub('vitamin_b6', 'Витамин B6', 'B6 vitamini', ['витамин b6', 'b6', 'пиридоксин'], { sort_order: 40 }),
    sub('p5p', 'P-5-P (активная форма B6)', 'P-5-P (B6 ning faol shakli)', ['p-5-p', 'p5p'], { kind: 'form', parent: 'vitamin_b6', sort_order: 41 }),
    sub('vitamin_d3', 'Витамин D3', 'D3 vitamini', ['витамин d3', 'd3', 'холекальциферол'], { sort_order: 10 }),
    sub('iron', 'Железо', 'Temir', ['железо', 'iron'], { sort_order: 120 }),
    sub('drugs_antibiotics', 'Лекарства: антибиотики (тетрациклины, фторхинолоны)', 'Dorilar: antibiotiklar', ['антибиотики', 'тетрациклины'], { kind: 'drug_group', sort_order: 920 }),
  ],
  rules: [
    { id: 'r-mg-b6', a: 'magnesium', b: 'vitamin_b6', kind: 'synergy', interval_hours: null, when_a: 'evening', when_b: 'evening', text_ru: 'B6 помогает магнию.', text_uz: 'B6 magniyga yordam beradi.', source: 'таблица', origin: 'xlsx', status: 'draft' },
    { id: 'r-mg-ab', a: 'magnesium', b: 'drugs_antibiotics', kind: 'drug_caution', interval_hours: 3, when_a: 'evening', when_b: 'any', text_ru: 'Разносят на 3 часа.', text_uz: '3 soat farq bilan.', source: null, origin: 'vitalo', status: 'approved' },
  ],
  categories: [
    { id: 'c1', slug: 'sleep', tree: 'need', name_ru: 'Сон и стресс', name_uz: 'Uyqu va stress', status: 'active', sort_order: 10, parent: null, merged_into: null, products: 1 },
    { id: 'c2', slug: 'energy', tree: 'need', name_ru: 'Энергия и мозг', name_uz: 'Energiya va miya', status: 'active', sort_order: 20, parent: null, merged_into: null, products: 1 },
    { id: 'c3', slug: 'minerals', tree: 'product_type', name_ru: 'Минералы', name_uz: 'Minerallar', status: 'active', sort_order: 10, parent: null, merged_into: null, products: 1 },
    { id: 'c4', slug: 'heart', tree: 'need', name_ru: 'Сердце и сосуды', name_uz: 'Yurak', status: 'archived', sort_order: 30, parent: null, merged_into: null, products: 0 },
  ],
  brands: [
    {
      id: 'b1',
      name: 'MioPharm',
      status: 'active',
      products: 1,
      cells: { name: 'MioPharm', country_ru: 'Россия', country_uz: 'Rossiya', why_ru: 'Фармацевтический подход.', why_uz: 'Farmatsevtik yondashuv.', show: 'Да', order: 1, logo: null },
    },
  ],
  products: [
    {
      id: 'p1',
      sku: 'OZN-T001',
      status: 'active',
      needs: ['Сон и стресс', 'Энергия и мозг'],
      substances: ['vitamin_b6', 'magnesium'],
      cells: {
        sku: 'OZN-T001',
        status: 'Активен',
        brand: 'MioPharm',
        name_ru: 'Магний B6, 60 таблеток',
        name_uz: 'Magniy B6, 60 tabletka',
        short_ru: 'Магний B6, 60 таб.',
        short_uz: 'Magniy B6, 60 tab.',
        need1: 'Сон и стресс',
        need2: 'Энергия и мозг',
        need3: null,
        type: 'Минералы',
        form: 'Таблетки',
        pack: 60,
        per_day: 2,
        price: 120000,
        comp_ru: 'Магний — 100 мг; B6 — 5 мг',
        substances: 'Витамин B6, Магний',
        std_bio: 'Да',
        std_tested: 'Да',
        std_orig: 'Да',
        halal: 'Не знаю',
        manufacturer: 'ООО «Пример»',
        country: 'Россия',
      },
    },
  ],
};

/** A small copy of docs/content/VITALO_catalog.xlsx: the sheets and header rows the export and the check need. */
async function makeTemplate(file: string) {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Инструкция');
  const header = (ws: ExcelJS.Worksheet, row: number, heads: string[]) => heads.forEach((h, i) => (ws.getCell(row, i + 1).value = h));
  const goods = wb.addWorksheet('Товары');
  header(goods, 2, PRODUCT_COLUMNS.map((c) => c.head));
  const cats = wb.addWorksheet('Категории');
  header(cats, 2, CATEGORY_COLUMNS.slice(0, 7).map((c) => c.label));
  header(cats, 22, CATEGORY_COLUMNS.slice(0, 7).map((c) => c.label));
  [['N1', 'Сон и стресс', 'Uyqu va stress', 1], ['N2', 'Энергия и мозг', 'Energiya va miya', 2]].forEach((v, i) => v.forEach((x, k) => (cats.getCell(3 + i, k + 1).value = x)));
  ['T1', 'Минералы', 'Minerallar', 1].forEach((x, k) => (cats.getCell(23, k + 1).value = x));
  for (const r of [3, 4, 23]) cats.getCell(r, 5).value = 'Да';
  const brands = wb.addWorksheet('Бренды');
  header(brands, 2, [...BRAND_COLUMNS.map((c) => c.label)]);
  brands.getCell('E2').value = 'Почему бренд в VITALO (RU)';
  brands.getCell('F2').value = '(UZ)';
  const rules = wb.addWorksheet('Правила совместимости');
  header(rules, 2, ['Вещество A', 'Вещество B', 'Тип связи', 'Интервал, часов', 'Когда принимать A', 'Когда принимать B', 'Объяснение для клиента RU', 'Объяснение UZ', 'Источник']);
  wb.addWorksheet('Справочники');
  await wb.xlsx.writeFile(file);
}

describe('catalog master table: lists and substances', () => {
  const dict: DictItem[] = DB.substances.map((s) => ({ ...s, order: s.sort_order, row: null, isNew: false }));

  it('splits a list by commas outside brackets only', () => {
    expect(splitList('Магний, витамин B6; Железо')).toEqual(['Магний', 'витамин B6', 'Железо']);
    expect(splitList('Лекарства: антибиотики (тетрациклины, фторхинолоны), Магний')).toEqual(['Лекарства: антибиотики (тетрациклины, фторхинолоны)', 'Магний']);
    expect(splitList(null)).toEqual([]);
  });

  it('finds substances by name, UZ name, synonym or code, in any case', () => {
    expect(resolveSubstances('магний, B6 VITAMINI, пиридоксин, iron, p5p', dict)).toEqual({ codes: ['magnesium', 'vitamin_b6', 'iron', 'p5p'], unknown: [] });
  });

  it('an unknown name comes with the closest names', () => {
    const r = resolveSubstances('Магнии, Витамин Д3', dict);
    expect(r.codes).toEqual([]);
    expect(r.unknown.map((u) => u.name)).toEqual(['Магнии', 'Витамин Д3']);
    expect(r.unknown[0].hints[0]).toBe('Магний');
    expect(r.unknown[1].hints[0]).toBe('Витамин D3');
    expect(closestSubstances('Коэнзим Q10', dict)).toEqual([]);
  });

  it('a new substance gets a code from its name', () => {
    expect(codeFromName('Koenzim Q10', new Set())).toBe('koenzim_q10');
    expect(codeFromName('Коэнзим Q10', new Set(['koenzim_q10']))).toBe('koenzim_q10_2');
  });
});

describe('catalog master table: export → check', () => {
  let dir: string;
  let sheets: CatalogSheets;
  const row = (rows: SheetRow[] | null, pick: (r: SheetRow) => boolean) => rows!.find(pick)!;
  const fresh = async () => readCatalogFile(join(dir, 'out.xlsx'));

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vitalo-catalog-'));
    await makeTemplate(join(dir, 'template.xlsx'));
    await writeCatalogWorkbook(join(dir, 'template.xlsx'), join(dir, 'out.xlsx'), DB, '03.11.2026');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(async () => {
    sheets = await fresh();
  });

  it('a fresh export has no errors and no changes', () => {
    const c = checkCatalog(sheets, DB);
    expect(c.errors).toEqual([]);
    expect(c.changes).toEqual([]);
    expect(sheets.substances).toHaveLength(6);
    expect(sheets.rules).toHaveLength(2);
    expect(row(sheets.products, (r) => r.v.sku === 'OZN-T001').v.substances).toBe('Витамин B6, Магний');
    expect(row(sheets.rules, (r) => r.v.id === 'r-mg-ab').v).toMatchObject({ a: 'Магний', status: 'Одобрено', action: 'Без изменений', approve: 'Нет', kind: 'Осторожно с лекарствами' });
  });

  it('after catalog:load the export puts the SKU into the row «Новый» (no second row) and the new brand gets «Без изменений»', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(dir, 'out.xlsx'));
    const col = (ws: ExcelJS.Worksheet, head: string) => (ws.getRow(2).values as unknown[]).findIndex((v) => String(v ?? '').toLowerCase().startsWith(head));
    const goods = wb.getWorksheet('Товары')!;
    goods.getCell(4, col(goods, 'артикул')).value = null; // the owner's new row: no SKU yet
    goods.getCell(4, col(goods, 'действие')).value = 'Новый';
    const brands = wb.getWorksheet('Бренды')!;
    brands.getCell(4, col(brands, 'действие')).value = 'Новый';
    await wb.xlsx.writeFile(join(dir, 'loaded.xlsx'));
    await writeCatalogWorkbook(join(dir, 'loaded.xlsx'), join(dir, 'again.xlsx'), DB, '07.11.2026');
    const again = await readCatalogFile(join(dir, 'again.xlsx'));
    expect(again.products).toHaveLength(1);
    expect(again.products![0].v).toMatchObject({ sku: 'OZN-T001', action: 'Без изменений' });
    expect(again.brands![0].v.action).toBe('Без изменений');
    expect(checkCatalog(again, DB)).toMatchObject({ errors: [], changes: [] });
  });

  it('an unknown substance of a product is an error with a hint; a synonym is fine', () => {
    const p = row(sheets.products, (r) => r.v.sku === 'OZN-T001');
    p.v.substances = 'пиридоксин, Магнии';
    const c = checkCatalog(sheets, DB);
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0].message).toContain('«Магнии» нет в справочнике веществ — может быть: «Магний»');
  });

  it('«Изменить» shows было → стало; «Без изменений» with a difference is only a warning', () => {
    const p = row(sheets.products, (r) => r.v.sku === 'OZN-T001');
    p.v.price = 135000;
    p.v.substances = 'Магний, Витамин B6, Железо';
    let c = checkCatalog(sheets, DB);
    expect(c.changes).toEqual([]);
    expect(c.warnings.some((w) => w.message.includes('Цена продажи') && w.message.includes('«Без изменений»'))).toBe(true);
    p.v.action = 'Изменить';
    c = checkCatalog(sheets, DB);
    expect(c.errors).toEqual([]);
    expect(c.changes).toHaveLength(1);
    expect(c.changes[0].fields).toEqual([
      { label: 'Цена продажи', before: '120000', after: '135000' },
      { label: 'Действующие вещества', before: '—', after: 'добавить: Железо' },
    ]);
    expect(formatCatalogCheck(c)).toContain('| Цена продажи | 120000 | 135000 |');
  });

  it('a product must use a brand and categories of the table', () => {
    const p = row(sheets.products, (r) => r.v.sku === 'OZN-T001');
    Object.assign(p.v, { action: 'Изменить', brand: 'NOW Foods', need2: 'Сердце и сосуды' });
    const msgs = checkCatalog(sheets, DB).errors.map((e) => e.message);
    expect(msgs.some((m) => m.includes('бренда «NOW Foods» нет на листе «Бренды»'))).toBe(true);
    expect(msgs.some((m) => m.includes('«Сердце и сосуды» нет среди показываемых потребностей'))).toBe(true);
  });

  it('«Одобрить: Да» approves a draft rule; «Выключить» turns a rule off', () => {
    row(sheets.rules, (r) => r.v.id === 'r-mg-b6').v.approve = 'Да';
    row(sheets.rules, (r) => r.v.id === 'r-mg-ab').v.action = 'Выключить';
    const c = checkCatalog(sheets, DB);
    expect(c.errors).toEqual([]);
    expect(c.changes.map((x) => [x.what, x.action, x.fields.at(-1)])).toEqual([
      ['Магний + Витамин B6', 'Одобрить', { label: 'Статус', before: 'Черновик', after: 'Одобрено' }],
      ['Магний + Лекарства: антибиотики (тетрациклины, фторхинолоны)', 'Выключить', { label: 'Статус', before: 'Одобрено', after: 'Выключено' }],
    ]);
  });

  it('a changed text of a rule; «Выключить» together with «Одобрить» is an error', () => {
    const r = row(sheets.rules, (x) => x.v.id === 'r-mg-b6');
    Object.assign(r.v, { action: 'Изменить', text_ru: 'Витамин B6 помогает магнию попасть в клетку.', approve: 'Да' });
    let c = checkCatalog(sheets, DB);
    expect(c.changes[0]).toMatchObject({ action: 'Изменить и одобрить' });
    expect(c.changes[0].fields.map((f) => f.label)).toEqual(['Объяснение RU', 'Статус']);
    r.v.action = 'Выключить';
    c = checkCatalog(sheets, DB);
    expect(c.errors.map((e) => e.message)).toEqual([expect.stringContaining('«Выключить» и «Одобрить: Да» вместе нельзя')]);
  });

  it('a new rule: the pair must be new, names from the dictionary, «когда» from the list', () => {
    sheets.rules!.push(
      { row: 10, v: { a: 'Железо', b: 'Витамин D3', kind: 'Разнести по времени', interval: 2, when_a: 'Утро', when_b: 'Вечер', text_ru: 'Лучше разнести.', text_uz: '', action: 'Новое', approve: 'Да' } },
      { row: 11, v: { a: 'витамин b6', b: 'магний', kind: 'Синергия', text_ru: 'Повтор.', text_uz: 'Takror.', action: 'Новое' } },
      { row: 12, v: { a: 'Железо', b: 'Кальций', kind: 'Синергия', when_a: 'Перед сном', text_ru: 'Текст.', text_uz: 'Matn.', action: 'Новое' } },
    );
    const c = checkCatalog(sheets, DB);
    expect(c.changes).toEqual([expect.objectContaining({ row: 10, what: 'Железо + Витамин D3', action: 'Новое, сразу одобрено' })]);
    expect(c.translate).toEqual([expect.objectContaining({ row: 10 })]);
    const msgs = c.errors.map((e) => `${e.row}: ${e.message}`);
    expect(msgs).toContainEqual(expect.stringMatching(/^11: .*для этой пары в базе уже есть правило/));
    expect(msgs).toContainEqual(expect.stringMatching(/^12: .*«Кальций» нет в справочнике веществ/));
    expect(msgs).toContainEqual(expect.stringMatching(/^12: .*Когда A: «Перед сном» не из списка/));
  });

  it('a new substance: its names must be free; then products and rules may use it', () => {
    sheets.substances!.push(
      { row: 20, v: { action: 'Новое', name_ru: 'Кальций', name_uz: 'Kalsiy', kind: 'Вещество', synonyms: 'кальций, карбонат кальция' } },
      { row: 21, v: { action: 'Новое', name_ru: 'Цитрат', name_uz: 'Sitrat', kind: 'Вещество', synonyms: 'цитрат магния' } },
    );
    sheets.rules!.push({ row: 10, v: { a: 'Кальций', b: 'Железо', kind: 'Разнести по времени', interval: 4, text_ru: 'Разнести.', text_uz: 'Ajrating.', action: 'Новое' } });
    const c = checkCatalog(sheets, DB);
    expect(c.errors.map((e) => e.message)).toEqual([expect.stringContaining('«цитрат магния» — и у «Магний», и у «Цитрат»')]);
    expect(c.changes.find((x) => x.what === 'Кальций')?.fields[0]).toEqual({ label: 'Код', before: '—', after: 'kalsiy' });
    expect(c.changes.some((x) => x.what === 'Кальций + Железо' && x.action === 'Новое')).toBe(true);
  });

  it('a form needs its substance; the code column must not be changed', () => {
    sheets.substances!.push({ row: 20, v: { action: 'Новое', name_ru: 'Бисглицинат железа', name_uz: 'Temir bisglitsinat', kind: 'Форма вещества' } });
    row(sheets.substances, (r) => r.v.code === 'iron').v.code = 'ironn';
    const msgs = checkCatalog(sheets, DB).errors.map((e) => e.message);
    expect(msgs).toContainEqual(expect.stringContaining('укажите, форма какого вещества'));
    expect(msgs).toContainEqual(expect.stringContaining('кода «ironn» нет в базе'));
  });
});
