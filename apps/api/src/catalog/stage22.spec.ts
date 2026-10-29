import { brandKey, similarBrandGroups, slugify, uniqueSlug } from './brand-names';
import { pickType, resolveTarget } from './stage22-transfer';

describe('stage 2.2: one product type by the first substance in the name', () => {
  // The products of vitalo_dev, as agreed with the owner on 30.10.2026.
  it.each([
    ['Коллаген морской с гиалуроновой кислотой и витамином с', ['collagen', 'vitamins'], 'collagen'],
    ['Креатин BODYHACK, моногидрат, порошок', ['other'], 'creatine-amino'],
    ['Порционный протеин 30 г, белок растительный', ['other'], 'protein'],
    ['Витамин D3 2000 МЕ, 180 таблеток', ['vitamins'], 'vitamins'],
    ['Магний В6 180 таблеток Blueline Миофарм от стресса', ['minerals', 'vitamins'], 'minerals'],
    ['Омега 3, рыбий жир в капсулах для взрослых', ['omega', 'vitamins'], 'omega'],
    ['Йод, калия йодат, витамины для щитовидной железы', ['minerals', 'vitamins'], 'minerals'],
    ['Комплекс витаминов для иммунитета, Магний, Витамин Д, Омега', ['minerals', 'omega', 'vitamins'], 'vitamins'],
    ['Комплекс витаминов - магний, витамин D, Омега-3', ['omega', 'vitamins'], 'vitamins'],
    ['Магний Цитрат VitaMeal с витамином В6', ['minerals', 'vitamins'], 'minerals'],
    ['Мультивитамин - комплекс витаминов для мужчин', ['minerals', 'vitamins'], 'vitamins'],
    ['Биотин 5000 мкг, 60 капсул', ['vitamins'], 'vitamins'],
    ['Цинк хелат 25 мг, 60 таблеток', ['minerals'], 'minerals'],
    ['Пробиотик комплекс, 10 штаммов', ['other'], 'other'],
    ['Мелатонин 3 мг, 60 таблеток', ['other'], 'other'],
  ])('%s -> %s', (name, oldTypes, expected) => {
    expect(pickType(name, oldTypes)).toBe(expected);
  });

  it('no substance and no old type: no type (shown in the table for the owner)', () => {
    expect(pickType('Набор для путешествий', [])).toBeNull();
  });
});

describe('stage 2.2: old category -> new one', () => {
  const rows = [
    { id: '1', slug: 'beauty', tree_type: 'need' as const, parent_id: null },
    { id: '2', slug: 'vitamins', tree_type: 'product_type' as const, parent_id: null },
    { id: '3', slug: 'minerals', tree_type: 'product_type' as const, parent_id: null },
  ];
  const byId = new Map(rows.map((r) => [r.id, r as never]));

  it('a new category stays itself', () => expect(resolveTarget({ slug: 'immunity', tree_type: 'need', parent_id: null }, byId)).toBe('immunity'));
  it('merged ones', () => {
    expect(resolveTarget({ slug: 'memory', tree_type: 'need', parent_id: null }, byId)).toBe('energy');
    expect(resolveTarget({ slug: 'beauty-skin', tree_type: 'need', parent_id: '1' }, byId)).toBe('beauty');
    expect(resolveTarget({ slug: 'probiotics', tree_type: 'product_type', parent_id: null }, byId)).toBe('other');
  });
  it('a subcategory goes to its parent', () => {
    expect(resolveTarget({ slug: 'vitamin-d', tree_type: 'product_type', parent_id: '2' }, byId)).toBe('vitamins');
    expect(resolveTarget({ slug: 'magnesium', tree_type: 'product_type', parent_id: '3' }, byId)).toBe('minerals');
  });
  it('«Сердце и сосуды» is only hidden; an unknown type goes to «Другие добавки»', () => {
    expect(resolveTarget({ slug: 'heart', tree_type: 'need', parent_id: null }, byId)).toBeNull();
    expect(resolveTarget({ slug: 'something', tree_type: 'product_type', parent_id: null }, byId)).toBe('other');
  });
});

describe('stage 2.2: brand addresses and similar names', () => {
  it('slug', () => {
    expect(slugify('NOW Foods')).toBe('now-foods');
    expect(slugify('Эвалар')).toBe('evalar');
    expect(slugify('Bai Altai')).toBe('bai-altai');
    expect(uniqueSlug('NOW Foods', new Set(['now-foods']))).toBe('now-foods-2');
    expect(uniqueSlug('★', new Set())).toBe('brand');
  });

  it('«NOW» and «NOW Foods», «Solgar» and «SOLGAR » are listed together; different brands are not', () => {
    expect(brandKey('NOW Foods')).toBe('now');
    const groups = similarBrandGroups([{ name_ru: 'NOW' }, { name_ru: 'NOW Foods' }, { name_ru: 'Solgar' }, { name_ru: 'SOLGAR ' }, { name_ru: 'OVER' }, { name_ru: 'OstroVit' }]);
    expect(groups.map((g) => g.map((b) => b.name_ru.trim()).sort())).toEqual([
      ['NOW', 'NOW Foods'],
      ['SOLGAR', 'Solgar'],
    ]);
  });
});
