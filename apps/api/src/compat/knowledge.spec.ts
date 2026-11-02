import { matchSubstances, normalizeText, PROPOSED_PRODUCT_SUBSTANCES, PROPOSED_RULES, rulesForProducts, substanceOfCell, withParents, type DictEntry } from './knowledge';

const dict: DictEntry[] = [
  { code: 'magnesium', name_ru: 'Магний', synonyms: ['магний', 'цитрат магния', 'бисглицинат магния'] },
  { code: 'vitamin_b6', name_ru: 'Витамин B6', synonyms: ['витамин b6', 'витамин в6', 'b6', 'в6', 'пиридоксин'] },
  { code: 'p5p', name_ru: 'P-5-P (активная форма B6)', synonyms: ['p-5-p', 'пиридоксаль-5-фосфат'] },
  { code: 'vitamin_d3', name_ru: 'Витамин D3', synonyms: ['витамин d3', 'd3', 'д3', 'холекальциферол'] },
  { code: 'vitamin_c', name_ru: 'Витамин C', synonyms: ['витамин c', 'витамин с', 'аскорбиновая кислота'] },
  { code: 'drugs_anticoagulants', name_ru: 'Лекарства: антикоагулянты (разжижающие кровь)', synonyms: ['антикоагулянты', 'разжижающие кровь'] },
  { code: 'drugs_thyroid', name_ru: 'Лекарства: гормоны щитовидной железы', synonyms: ['гормоны щитовидной железы', 'l-тироксин'] },
];

describe('3.8: dictionary of substances', () => {
  it('finds substances by synonyms in a free text, the longest synonym first', () => {
    expect(matchSubstances('Цитрат магния + Витамин B6 (пиридоксин)', dict)).toEqual(['magnesium', 'vitamin_b6']);
    expect(matchSubstances('Холекальциферол (витамин D3) 2000 МЕ', dict)).toEqual(['vitamin_d3']);
    // Cyrillic «С» in «Витамин С» is a synonym of its own
    expect(matchSubstances('Витамин С 500 мг', dict)).toEqual(['vitamin_c']);
    expect(matchSubstances('P-5-P 50 мг', dict)).toEqual(['p5p']);
  });

  it('a synonym counts only as a whole word', () => {
    expect(matchSubstances('Магниевый комплекс', dict)).toEqual([]);
    expect(matchSubstances('ab6c', dict)).toEqual([]);
  });

  it('normalises case, «ё» and quotes', () => {
    expect(normalizeText('  «Магний»   ЁЛКА ')).toBe('магний елка');
  });

  it('a form takes the rules of its substance (P-5-P → B6)', () => {
    const parentOf = new Map<string, string | null>([['p5p', 'vitamin_b6'], ['vitamin_b6', null]]);
    expect([...withParents(['p5p'], parentOf)].sort()).toEqual(['p5p', 'vitamin_b6']);
  });

  it('reads one substance from a cell of the sheet, drug groups included', () => {
    expect(substanceOfCell('лекарства: антикоагулянты / разжижающие кровь', dict)).toEqual({ code: 'drugs_anticoagulants' });
    expect(substanceOfCell('лекарства: гормоны щитовидной железы (L-тироксин)', dict)).toEqual({ code: 'drugs_thyroid' });
    expect(substanceOfCell('кальций', dict)).toEqual({ error: 'нет в справочнике веществ' });
    expect(substanceOfCell('магний и витамин D3', dict)).toMatchObject({ error: expect.stringContaining('несколько') });
  });
});

describe('3.8: rules for a cart', () => {
  const rules = [
    { id: 'mg-b6', substance_a_id: 'magnesium', substance_b_id: 'vitamin_b6' },
    { id: 'zn-fe', substance_a_id: 'zinc', substance_b_id: 'iron' },
  ];

  it('2+ products: a rule counts only between different products', () => {
    const multi = { id: 'multi', substances: new Set(['zinc', 'iron']) };
    const mg = { id: 'mg', substances: new Set(['magnesium']) };
    const b6 = { id: 'b6', substances: new Set(['vitamin_b6', 'p5p']) };
    expect(rulesForProducts([multi, mg], rules)).toEqual([]);
    expect(rulesForProducts([mg, b6], rules).map((r) => r.id)).toEqual(['mg-b6']);
    expect(rulesForProducts([b6, mg], rules).map((r) => r.id)).toEqual(['mg-b6']);
  });

  it('one product: every rule where it has A or B', () => {
    expect(rulesForProducts([{ id: 'mg', substances: new Set(['magnesium']) }], rules).map((r) => r.id)).toEqual(['mg-b6']);
  });
});

describe('3.8: starting proposals', () => {
  it('no pair twice and no rule of a substance with itself', () => {
    const keys = PROPOSED_RULES.map((r) => [r.a, r.b].sort().join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    expect(PROPOSED_RULES.every((r) => r.a !== r.b && r.text_ru && r.text_uz)).toBe(true);
  });

  it('texts follow D-33: no «лечит», «100%», «гарантирует»', () => {
    const all = PROPOSED_RULES.flatMap((r) => [r.text_ru, r.text_uz]).join(' ').toLowerCase();
    for (const w of ['лечит', '100%', 'гарантир', 'davolaydi', 'kafolat']) expect(all).not.toContain(w);
  });

  it('every product proposal has at least one substance', () => {
    expect(Object.values(PROPOSED_PRODUCT_SUBSTANCES).every((l) => l.length > 0)).toBe(true);
  });
});
