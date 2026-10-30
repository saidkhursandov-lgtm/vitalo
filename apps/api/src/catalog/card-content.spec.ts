import { BRAND_WHY, RISKY, buildCardPlan, halalVegeRule, shellRule } from './card-content';
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
    // owner: 180 tablets as on the photo, 4 a day → 45 days; the staff note asks to check the stock
    expect(d).toMatchObject({ pack_count: 180, servings_per_day: 4, std_bioavailability: true, std_original: false, market_advantage_percent: 15, halal_vege: 'unknown', shell_ru: null });
    expect(d).toMatchObject({ short_name_ru: 'Магний Цитрат + B6, 180 таб.', short_name_uz: 'Magniy Sitrat + B6, 180 tab.' });
    expect(courseDays(Number(d.pack_count), Number(d.servings_per_day))).toBe(45);
    expect(d.doctor_verdict_ru).toBe('Цитрат магния усваивается значительно лучше оксида магния и мягче для желудка.');
    expect(plan.softened).toHaveLength(1);
    expect(d.admin_note).toBe('На фото 180 таблеток, в полном названии 200 — сверить количество на складе.');
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

describe('2.3 fixes: «Почему [бренд] в VITALO» replaced as a whole (D-34)', () => {
  it('the owner text instead of the sheet one; the plan shows what is in the database now → the new text', () => {
    const brand = (dbName: string, why: string) => ({ row: 2, dbName, country_ru: null, country_uz: null, why_ru: why, why_uz: why, showcase: null, order: null, logo: null });
    const plan = buildCardPlan(
      { brands: [brand('VitaMeal', 'Текст из файла.'), brand('Другой бренд', 'Текст из файла.')], products: [] },
      {
        ...db,
        brands: [...db.brands, { id: 'b-vm', name_ru: 'VitaMeal', why_vitalo_ru: 'Старый текст.', why_vitalo_uz: 'Eski matn.' }, { id: 'b-x', name_ru: 'Другой бренд' }],
      },
    );
    const vm = plan.brands.find((b) => b.brand.id === 'b-vm')!;
    expect(vm.why_ru).toBe(BRAND_WHY.VitaMeal.ru);
    expect(vm.why_uz).toBe(BRAND_WHY.VitaMeal.uz);
    expect(vm.why_ru).toMatch(/^Российский производитель функциональных комплексов\./);
    expect(plan.softened.filter((s) => s.key === 'VitaMeal').map((s) => [s.field, s.from])).toEqual([
      ['why_ru', 'Старый текст.'],
      ['why_uz', 'Eski matn.'],
    ]);
    // a brand without its own text is not touched
    expect(plan.brands.some((b) => b.brand.id === 'b-x')).toBe(false);
  });

  it('all five owner texts are about the brand and the selection: no product names, doses or risky words except «профилакт» (D-34)', () => {
    expect(Object.keys(BRAND_WHY).sort()).toEqual(['Bai Altai', 'GreenGo', 'MioPharm', 'OVER', 'VitaMeal']);
    for (const [name, t] of Object.entries(BRAND_WHY)) {
      for (const text of [t.ru, t.uz]) {
        expect(text).toContain(name);
        expect(text).not.toMatch(/d+s?(мг|мкг|mg|mkg|МЕ)|омега|коллаген|магни|йод|D3|kollagen|magniy/i);
        expect(text.replace(/профилакт|profilakt/gi, '')).not.toMatch(RISKY);
      }
    }
  });
});
