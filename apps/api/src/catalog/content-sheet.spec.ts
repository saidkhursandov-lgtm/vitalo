import { buildContentPlan, ContentSheet, DbCategory, DbProduct, nameScore, SheetProduct } from './content-sheet';

const cats: DbCategory[] = [
  { id: 'sleep', name_ru: 'Сон и стресс', tree_type: 'need' },
  { id: 'energy', name_ru: 'Энергия и мозг', tree_type: 'need' },
  { id: 'joints', name_ru: 'Суставы и кости', tree_type: 'need' },
  { id: 'minerals', name_ru: 'Минералы', tree_type: 'product_type' },
  { id: 'vitamins', name_ru: 'Витамины', tree_type: 'product_type' },
];
const product = (sku: string, name: string, brand: string, needs: string[] = [], types: string[] = ['minerals']): DbProduct => ({
  id: 'id-' + sku,
  sku,
  name_ru: name,
  status: 'active',
  brand_name: brand,
  needs,
  types,
});
const row = (sku: string, name: string, brand: string, extra: Partial<SheetProduct> = {}): SheetProduct => ({
  row: 3,
  sku,
  name,
  brand,
  short_ru: 'Магний B6, 200 таб.',
  short_uz: 'Magniy B6, 200 tab.',
  needs: ['Сон и стресс', 'Энергия и мозг'],
  type: 'Минералы',
  ...extra,
});
const db = {
  brands: [{ id: 'b-mio', name_ru: 'MioPharm' }],
  categories: cats,
  products: [
    product('A014', 'Магний В6 180 таблеток Blueline Миофарм от стресса', 'MioPharm', ['sleep', 'joints']),
    product('A022', 'Магний В6 200 таблеток Blueline Миофарм от стресса', 'MioPharm', ['sleep']),
    product('A003', 'Витамин D3 2000 МЕ, 180 таблеток', 'MioPharm', [], ['vitamins']),
  ],
};
const sheet = (products: SheetProduct[]): ContentSheet => ({ brands: [], products });

describe('content sheet → database plan', () => {
  it('scores names by shared words, ignoring Cyrillic «В6» vs Latin «B6»', () => {
    expect(nameScore('Магний В6 200 таблеток', 'Магний B6 200 таблеток')).toBe(1);
    expect(nameScore('Магний В6 200 таблеток', 'Витамин D3 180 таблеток')).toBeLessThan(0.6);
  });

  it('matches by brand and name; the pack size tells similar products apart', () => {
    const plan = buildContentPlan(sheet([row('MP-200', 'Магний В6 200 таблеток Blueline Миофарм от стресса', 'MioPharm')]), db);
    expect(plan.products.map((u) => u.product.sku)).toEqual(['A022']);
    expect(plan.products[0].addNeeds).toEqual(['energy']);
    expect(plan.products[0].removeNeeds).toEqual([]);
    expect(plan.products[0].setType).toBeNull();
  });

  it('needs become exactly as in the sheet: missing ones added, extra ones removed', () => {
    const plan = buildContentPlan(sheet([row('MP-180', 'Магний В6 180 таблеток Blueline Миофарм', 'MioPharm')]), db);
    expect(plan.products[0].product.sku).toBe('A014');
    expect(plan.products[0].addNeeds).toEqual(['energy']);
    expect(plan.products[0].removeNeeds).toEqual(['joints']);
  });

  it('a changed type replaces the old one', () => {
    const plan = buildContentPlan(sheet([row('D3', 'Витамин D3 2000 МЕ, 180 таблеток', 'MioPharm', { type: 'Минералы' })]), db);
    expect(plan.products[0].setType).toBe('minerals');
  });

  it('a product of another brand or with an unlike name is reported, never created', () => {
    const plan = buildContentPlan(
      sheet([row('NOW-1', 'Магний В6 200 таблеток', 'NOW Foods'), row('MP-X', 'Омега-3 рыбий жир 1000 мг', 'MioPharm')]),
      db,
    );
    expect(plan.products).toEqual([]);
    expect(plan.notFound.map((p) => p.sku)).toEqual(['NOW-1', 'MP-X']);
  });

  it('--skip leaves a row out, --map ties it by hand', () => {
    const rows = [row('MP-200', 'Магний В6 200 таблеток Blueline', 'MioPharm'), row('MP-ANY', 'что-то совсем другое', 'MioPharm')];
    const plan = buildContentPlan(sheet(rows), db, { skip: ['MP-200'], map: { 'MP-ANY': 'A014' } });
    expect(plan.skipped.map((p) => p.sku)).toEqual(['MP-200']);
    expect(plan.products.map((u) => u.product.sku)).toEqual(['A014']);
  });

  it('a row with a too long short name, an unknown need or no type is not loaded', () => {
    const plan = buildContentPlan(
      sheet([
        row('L', 'Магний В6 200 таблеток Blueline', 'MioPharm', { short_ru: 'х'.repeat(41) }),
        row('N', 'Магний В6 180 таблеток Blueline', 'MioPharm', { needs: ['Сердце'] }),
        row('T', 'Витамин D3 2000 МЕ, 180 таблеток', 'MioPharm', { type: null }),
      ]),
      db,
    );
    expect(plan.products).toEqual([]);
    expect(plan.errors.map((e) => e.sku)).toEqual(['L', 'N', 'T']);
    expect(plan.errors[0].text).toMatch(/40/);
  });

  it('one database product cannot take two sheet rows', () => {
    const plan = buildContentPlan(
      sheet([row('A', 'Магний В6 200 таблеток Blueline', 'MioPharm'), row('B', 'Магний В6 200 таблеток Миофарм', 'MioPharm')]),
      db,
    );
    expect(plan.products).toHaveLength(1);
    expect(plan.errors[0].text).toMatch(/уже сопоставлен/);
  });

  it('brands are matched by name; missing ones are listed, not created', () => {
    const b = { row: 3, country_ru: 'Россия', country_uz: 'Rossiya', why_ru: 'Текст', why_uz: 'Matn', showcase: true, order: 4, logo: null };
    const plan = buildContentPlan({ brands: [{ ...b, dbName: 'miopharm' }, { ...b, dbName: 'NOW Foods' }], products: [] }, db);
    expect(plan.brands.map((x) => x.brand.id)).toEqual(['b-mio']);
    expect(plan.brandsMissing.map((x) => x.dbName)).toEqual(['NOW Foods']);
  });
});
