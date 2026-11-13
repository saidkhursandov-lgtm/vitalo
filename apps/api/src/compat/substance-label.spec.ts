import { buildFormLabel, suggestSubstances, type SuggestDictEntry } from './substance-label';

const entry = (id: string, name_ru: string, extra: Partial<SuggestDictEntry> = {}): SuggestDictEntry => ({
  id,
  code: id,
  kind: 'substance',
  name_ru,
  name_uz: name_ru,
  synonyms: [],
  parent_id: null,
  enabled: true,
  ...extra,
});

const dict: SuggestDictEntry[] = [
  entry('mg', 'Магний', { synonyms: ['magnesium', 'магния'] }),
  entry('mg_cit', 'Магний цитрат', { kind: 'form', parent_id: 'mg', synonyms: ['цитрат магния', 'magnesium citrate'] }),
  entry('b6', 'Витамин B6', { name_uz: 'B6 vitamini', synonyms: ['b6'] }),
  entry('collagen', 'Коллаген', { synonyms: ['collagen', 'kollagen'] }),
  entry('vit_c', 'Витамин C', { synonyms: ['vitamin c'] }),
  entry('anticoag', 'Антикоагулянты', { kind: 'drug_group', synonyms: ['collagen'] }),
  entry('off', 'Старое', { enabled: false, synonyms: ['up'] }),
];

describe('buildFormLabel', () => {
  it('joins the dictionary names in order, RU and UZ', () => {
    expect(buildFormLabel([{ name_ru: 'Магний цитрат', name_uz: 'Magniy sitrat' }, { name_ru: 'Витамин B6', name_uz: 'B6 vitamini' }])).toEqual({
      ru: 'Магний цитрат + Витамин B6',
      uz: 'Magniy sitrat + B6 vitamini',
    });
  });

  it('nothing chosen — no label', () => {
    expect(buildFormLabel([])).toEqual({ ru: null, uz: null });
  });

  it('refuses a label longer than 60 characters', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ name_ru: `Вещество номер ${i}`, name_uz: `Modda ${i}` }));
    expect(() => buildFormLabel(many)).toThrow(/длиннее 60/);
  });
});

describe('suggestSubstances', () => {
  it('finds the form, not also its substance, whatever the word order', () => {
    expect(suggestSubstances({ name_ru: 'Цитрат магния + B6, 120 таблеток' }, dict)).toEqual([
      { id: 'mg_cit', strong: true },
      { id: 'b6', strong: true },
    ]);
  });

  it('an English name of a US product works through synonyms; drug groups and switched-off entries are never suggested', () => {
    // in the order of the name, not by the length of the synonym
    expect(suggestSubstances({ name_ru: 'California Gold Nutrition Collagen UP, Vitamin C' }, dict)).toEqual([
      { id: 'collagen', strong: true },
      { id: 'vit_c', strong: true },
    ]);
  });

  it('found only in the full composition — a weak suggestion', () => {
    expect(suggestSubstances({ name_ru: 'Коллаген', composition_ru: 'Коллаген, витамин C, магния стеарат' }, dict)).toEqual([
      { id: 'collagen', strong: true },
      { id: 'vit_c', strong: false },
      { id: 'mg', strong: false },
    ]);
  });
});
