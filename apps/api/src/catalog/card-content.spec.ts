import { buildCardPlan, halalVegeRule, shellRule } from './card-content';
import { ContentSheet, DbProduct, SheetCard, SheetProduct } from './content-sheet';
import { courseDays } from './product.mapper';

const card = (extra: Partial<SheetCard> = {}): SheetCard => ({
  substance_ru: 'Цитрат + B6',
  substance_uz: 'Sitrat + B6',
  pack: '200',
  per_day: '4',
  std_bio: 'Да',
  std_tested: 'Да',
  std_original: 'Нет',
  halal_vege: 'Не знаю',
  shell: 'Не знаю',
  source: null,
  market: '15',
  verdict_ru: 'Цитрат магния усваивается в разы лучше дешевого аптечного оксида и не раздражает желудок.',
  verdict_uz: 'Matn.',
  memo_ru: null,
  memo_uz: null,
  ...extra,
});
const row = (sku: string, name: string, c: SheetCard): SheetProduct => ({
  row: 3,
  sku,
  name,
  brand: 'MioPharm',
  short_ru: 'Магний B6, 200 таб.',
  short_uz: 'Magniy B6, 200 tab.',
  needs: ['Сон и стресс'],
  type: 'Минералы',
  card: c,
});
const product = (sku: string, name: string): DbProduct => ({ id: 'id-' + sku, sku, name_ru: name, status: 'active', brand_name: 'MioPharm', needs: [], types: [] });
const db = {
  brands: [{ id: 'b-mio', name_ru: 'MioPharm' }],
  categories: [
    { id: 'sleep', name_ru: 'Сон и стресс', tree_type: 'need' as const },
    { id: 'minerals', name_ru: 'Минералы', tree_type: 'product_type' as const },
  ],
  products: [product('OZN-A022', 'Магний В6 200 таблеток Blueline Миофарм'), product('OZN-A013', 'Коллаген Blue Line, 120 капс.')],
};
const sheet = (products: SheetProduct[]): ContentSheet => ({ brands: [], products });

describe('2.3: «Хватит на N дней»', () => {
  it('pack / per day, rounded down; hidden when empty or under 7 days', () => {
    expect(courseDays(200, 4)).toBe(50);
    expect(courseDays(100, 3)).toBe(33);
    expect(courseDays(12, 2)).toBeNull();
    expect(courseDays(null, 2)).toBeNull();
    expect(courseDays(60, null)).toBeNull();
  });
});

describe('2.3: Halal / VEGE (D-32)', () => {
  it('Halal only with a certificate cited from the label, the site or the certificate', () => {
    expect(halalVegeRule('Halal', 'Сертификат Halal партии 2026').value).toBe('halal');
    expect(halalVegeRule('Halal', 'На этикетке указан Bovine Gelatin').value).toBe('unknown');
    expect(halalVegeRule('Halal', 'Говяжий коллаген (уточнить сертификат партии)')).toEqual({ value: 'unknown', why: 'было «Halal»: Halal — нет сертификата' });
  });

  it('VEGE only from the label; «Нет» and «Не знаю» stay as they are', () => {
    expect(halalVegeRule('VEGE', 'Маркировка Veg Capsules на банке').value).toBe('vege');
    expect(halalVegeRule('VEGE', 'Таблетки без желатина (состав на этикетке)').value).toBe('vege');
    expect(halalVegeRule('VEGE', 'Линейка в капсуле HPMC (официальный сайт)').value).toBe('unknown');
    expect(halalVegeRule('Halal и VEGE', 'Сверить на этикетке').value).toBe('unknown');
    expect(halalVegeRule('Нет', null).value).toBe('none');
    expect(halalVegeRule('Не знаю', null).value).toBe('unknown');
    expect(halalVegeRule(null, null).value).toBeNull();
  });

  it('the shell line: «Не знаю» means no line; Uzbek from the list', () => {
    expect(shellRule('Говяжий желатин')).toEqual({ ru: 'говяжий желатин', uz: 'mol jelatini' });
    expect(shellRule('Не знаю')).toEqual({ ru: null, uz: null });
  });
});

describe('2.3: card plan', () => {
  it('fields from the sheet, the verdict softened (D-33), the photo note for OZN-A022', () => {
    const plan = buildCardPlan(sheet([row('MP-MAGB6-200', 'Магний В6 200 таблеток Blueline Миофарм', card())]), db);
    expect(plan.errors).toEqual([]);
    const d = plan.products[0].data;
    expect(plan.products[0].product.sku).toBe('OZN-A022');
    expect(d).toMatchObject({ pack_count: 200, servings_per_day: 4, std_bioavailability: true, std_original: false, market_advantage_percent: 15, halal_vege: 'unknown', shell_ru: null });
    expect(d.doctor_verdict_ru).toBe('Цитрат магния усваивается значительно лучше оксида магния и мягче для желудка.');
    expect(plan.softened).toHaveLength(1);
    expect(d.admin_note).toMatch(/сверить при следующей поставке/);
    // needs and types are not part of the card load
    expect(Object.keys(d)).not.toContain('needs');
  });

  it('the photo check fixes the count and the name where the photo is clear', () => {
    const plan = buildCardPlan(sheet([row('MP-COLL-90', 'Коллаген Blue Line', card({ pack: '90', shell: 'Без капсулы', verdict_ru: null }))]), db);
    expect(plan.products[0].product.sku).toBe('OZN-A013'); // tied by CARD_MAP
    expect(plan.products[0].data).toMatchObject({ pack_count: 120, short_name_ru: 'Коллаген + Вит C, 120 капс.', shell_ru: 'желатиновая капсула' });
  });

  it('a wrong number is an error, the row is not loaded; a leftover risky word is a warning', () => {
    const plan = buildCardPlan(
      sheet([
        row('MP-MAGB6-200', 'Магний В6 200 таблеток Blueline Миофарм', card({ market: '60' })),
        row('MP-COLL-90', 'Коллаген Blue Line', card({ verdict_ru: 'Лечит суставы.' })),
      ]),
      db,
    );
    expect(plan.errors.map((e) => e.sku)).toEqual(['MP-MAGB6-200']);
    expect(plan.errors[0].text).toMatch(/0–50/);
    expect(plan.warnings.some((w) => /MP-COLL-90.*Леч/.test(w))).toBe(true);
    // a softening phrase that is not in the text is reported, not guessed
    expect(plan.warnings.some((w) => /MP-COLL-90.*не найдена/.test(w))).toBe(true);
  });
});
