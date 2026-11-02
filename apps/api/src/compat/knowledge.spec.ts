import { applyOverlapFloor, matchSubstances, normalizeText, OVERLAP_TEXT, overlapsForProducts, pairKey, PROPOSED_PRODUCT_SUBSTANCES, PROPOSED_RULES, PROPOSED_SUBSTANCES, rulesForProducts, SHEET_RULE_EDITS, substanceOfCell, withParents, type DictEntry } from './knowledge';

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

describe('3.8: wording of the rules (D-33, D-45)', () => {
  const drugRules = [...PROPOSED_RULES.filter((r) => r.kind === 'drug_caution'), ...Object.entries(SHEET_RULE_EDITS).filter(([k]) => k.includes('drugs_')).map(([, e]) => e)];

  it('no «можно / нельзя» on behalf of AI, a doctor or a VITALO specialist every time', () => {
    const texts = [...PROPOSED_RULES, ...Object.values(SHEET_RULE_EDITS)].flatMap((r) => [r.text_ru ?? '', r.text_uz ?? '']);
    for (const t of texts) expect(t.toLowerCase()).not.toMatch(/(^|\s)(можно|нельзя)(\s|[.,]|$)|(qilish|ichish) mumkin|mumkin emas|идеальн|ideal /);
    for (const r of drugRules) {
      expect(r.text_ru).toMatch(/врач|эндокринолог/);
      expect(r.text_ru).toContain('специалист');
      expect(r.text_uz).toMatch(/shifokor/);
    }
  });

  it('the usual interval in hours: 4 for L-thyroxine, 3 for antibiotics; none for blood thinners', () => {
    for (const r of PROPOSED_RULES.filter((x) => x.b === 'drugs_thyroid')) expect([r.interval_hours, /4 час/.test(r.text_ru)]).toEqual([4, true]);
    for (const r of PROPOSED_RULES.filter((x) => x.b === 'drugs_antibiotics')) expect([r.interval_hours, /3 час/.test(r.text_ru)]).toEqual([3, true]);
    expect(SHEET_RULE_EDITS[pairKey('omega3', 'drugs_anticoagulants')]).toMatchObject({ interval_hours: null, text_ru: expect.stringContaining('не решает') });
    expect(SHEET_RULE_EDITS[pairKey('iodine', 'drugs_thyroid')]).toMatchObject({ interval_hours: 4 });
  });

  it('a pair key does not depend on the order', () => {
    expect(pairKey('zinc', 'iron')).toBe(pairKey('iron', 'zinc'));
  });
});

describe('3.8: the same substance in different products (Overlap Check, D-47)', () => {
  const parentOf = new Map<string, string | null>([['p5p', 'vitamin_b6']]);
  const multi = { id: 'multi', substances: ['multivitamin', 'vitamin_d3', 'iron', 'zinc', 'vitamin_c'] };
  const d3 = { id: 'd3', substances: ['vitamin_d3'] };
  const collagen = { id: 'collagen', substances: ['collagen', 'vitamin_c'] };

  it('finds a substance in 2+ different products, forms included', () => {
    expect(overlapsForProducts([multi, d3], parentOf)).toEqual([{ substance: 'vitamin_d3', products: ['multi', 'd3'] }]);
    expect(overlapsForProducts([{ id: 'a', substances: ['p5p'] }, { id: 'b', substances: ['vitamin_b6'] }], parentOf).map((o) => o.substance)).toEqual(['vitamin_b6']);
    expect(overlapsForProducts([d3], parentOf)).toEqual([]);
  });

  it('any overlap — at least yellow; red only from rules, never lowered', () => {
    const iron = overlapsForProducts([multi, { id: 'fe', substances: ['iron'] }], parentOf);
    expect(applyOverlapFloor('compatible', iron)).toBe('spread');
    expect(applyOverlapFloor('compatible', overlapsForProducts([multi, collagen], parentOf))).toBe('spread');
    expect(applyOverlapFloor('consult', iron)).toBe('consult');
    expect(applyOverlapFloor('compatible', [])).toBe('compatible');
    expect(OVERLAP_TEXT.ru).toContain('суммарную дозировку');
  });

  it('the starting product proposals use only dictionary codes of the migration or of PROPOSED_SUBSTANCES', () => {
    const codes = new Set(Object.values(PROPOSED_PRODUCT_SUBSTANCES).flat());
    expect(codes.has('vitamin_k1')).toBe(true);
    expect(codes.has('vitamin_k2')).toBe(false); // no product has K2 (MK-7): the multivitamins have K1
    expect(PROPOSED_SUBSTANCES.map((s) => s.code)).toContain('vitamin_k1');
  });
});
