import { checkEnrichAnswer, enrichDataBlock, mergeEnrichment, type EnrichDictEntry, type EnrichPayload } from './enrich';
import { timingColumns } from './knowledge.service';
import { joinWhen, ruleTiming, splitWhen, timingText, whenColumns } from './knowledge';

const e = (id: string, code: string, name: string, parent: string | null = null, extra: Partial<EnrichDictEntry> = {}): EnrichDictEntry => ({
  id,
  code,
  kind: parent ? 'form' : 'substance',
  name_ru: name,
  name_uz: name,
  synonyms: [],
  parent_id: parent,
  enabled: true,
  ...extra,
});

const dict: EnrichDictEntry[] = [
  e('mg', 'magnesium', 'Магний'),
  e('mgc', 'magnesium_citrate', 'Магний цитрат', 'mg'),
  e('b6', 'vitamin_b6', 'Витамин B6'),
  e('d3', 'vitamin_d3', 'Витамин D3'),
  e('k2', 'vitamin_k2', 'Витамин K2'),
  e('off', 'old_one', 'Старое', null, { enabled: false }),
  e('drug', 'anticoagulants', 'Антикоагулянты', null, { kind: 'drug_group' }),
];

describe('VITALO AI enrichment: the check of the answer', () => {
  it('keeps dictionary codes only, drops a parent next to its form, a dose needs a unit', () => {
    const r = checkEnrichAnswer(
      {
        substances: [
          { code: 'magnesium', dose_amount: 200, dose_unit: 'mg', in_label: true },
          { code: 'magnesium_citrate', dose_amount: 200, dose_unit: 'mg', in_label: true },
          { code: 'vitamin_b6', dose_amount: 5, dose_unit: null, in_label: true },
          { code: 'old_one', dose_amount: null, dose_unit: null, in_label: false },
          { code: 'anticoagulants', dose_amount: null, dose_unit: null, in_label: false },
          { code: 'made_up', dose_amount: 1, dose_unit: 'mg', in_label: false },
          { code: 'vitamin_b6', dose_amount: 5, dose_unit: 'mg', in_label: false },
        ],
        unknown: [{ name: 'Таурин', dose: '100 мг' }, { name: 'x', dose: null }],
        audience: 'adult',
        goals: ['sleep', 'stress', 'nonsense', 'sleep'],
        note: '',
      },
      dict,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.substances.map((s) => s.code)).toEqual(['magnesium_citrate', 'vitamin_b6']);
    expect(r.payload.substances[0]).toMatchObject({ dose_amount: 200, dose_unit: 'mg', in_label: true, parent_name: 'Магний' });
    expect(r.payload.substances[1]).toMatchObject({ dose_amount: null, dose_unit: null });
    expect(r.payload.unknown).toEqual([{ name: 'Таурин', dose: '100 мг' }]);
    expect(r.payload.goals).toEqual(['sleep', 'stress']);
  });

  it('«unknown» drops nutrition facts and what the draft already has (with its parent), keeps the really new', () => {
    const omega = [e('o3', 'omega3', 'Омега-3', null, { synonyms: ['дгк', 'dha', 'эпк'] }), e('o3r', 'omega3_rtg', 'Омега-3 rTG', 'o3')];
    const r = checkEnrichAnswer(
      {
        substances: [{ code: 'omega3_rtg', dose_amount: 1000, dose_unit: 'mg', in_label: true }],
        unknown: [
          { name: 'Углеводы', dose: '4,8 г' },
          { name: 'Сахара', dose: null },
          { name: 'ДГК (DHA)', dose: '250 мг' },
          { name: 'Холин', dose: '50 мг' },
        ],
        audience: 'any',
        goals: [],
        note: '',
      },
      [...dict, ...omega],
    );
    expect(r.ok && r.payload.unknown).toEqual([{ name: 'Холин', dose: '50 мг' }]);
  });

  it('nothing found is a failure; a wrong audience becomes «any»', () => {
    expect(checkEnrichAnswer({ substances: [], unknown: [], audience: 'x', goals: [], note: '' }, dict)).toEqual({ ok: false, error: 'empty' });
    const r = checkEnrichAnswer({ substances: [{ code: 'vitamin_d3', dose_amount: 600, dose_unit: 'iu', in_label: true }], unknown: [], audience: 'x', goals: [], note: '' }, dict);
    expect(r.ok && r.payload.audience).toBe('any');
  });

  it('the data block has the card and the dictionary, not the switched-off entries and drug groups', () => {
    const block = enrichDataBlock({ name_ru: 'Магний цитрат + B6', composition_ru: 'магния цитрат 200 мг' }, dict);
    expect(block).toContain('Название: Магний цитрат + B6');
    expect(block).toContain('- magnesium_citrate | Магний цитрат | форма вещества magnesium');
    expect(block).not.toContain('old_one');
    expect(block).not.toContain('anticoagulants');
  });
});

describe('VITALO AI enrichment: «Принять» keeps a person’s work', () => {
  const parentOf = new Map(dict.map((d) => [d.id, d.parent_id]));
  const names = new Map(dict.map((d) => [d.id, { name_ru: d.name_ru, name_uz: d.name_uz }]));
  const draft = (subs: Partial<EnrichPayload['substances'][number]>[]): EnrichPayload => ({
    substances: subs.map((s) => ({ id: '', code: '', kind: 'substance', name_ru: '', name_uz: '', parent_name: null, dose_amount: null, dose_unit: null, in_label: false, ...s })),
    unknown: [],
    audience: 'adult',
    goals: [],
    note: '',
  });

  it('the form replaces its parent and takes over its label mark; a hand dose stays; other substances stay', () => {
    const merged = mergeEnrichment(
      [
        { id: 'mg', in_label: true, dose_amount: null, dose_unit: null },
        { id: 'b6', in_label: false, dose_amount: 10, dose_unit: 'mg' },
        { id: 'd3', in_label: false, dose_amount: null, dose_unit: null },
      ],
      draft([
        { id: 'mgc', in_label: false, dose_amount: 200, dose_unit: 'mg' },
        { id: 'b6', in_label: true, dose_amount: 5, dose_unit: 'mg' },
      ]),
      parentOf,
      names,
    );
    expect(merged).toEqual([
      { id: 'mgc', in_label: true, dose_amount: 200, dose_unit: 'mg' },
      { id: 'b6', in_label: false, dose_amount: 10, dose_unit: 'mg' },
      { id: 'd3', in_label: false, dose_amount: null, dose_unit: null },
    ]);
  });

  it('a product without a label takes the draft marks', () => {
    const merged = mergeEnrichment([], draft([{ id: 'd3', in_label: true }, { id: 'k2', in_label: true }]), parentOf, names);
    expect(merged.map((m) => m.in_label)).toEqual([true, true]);
  });
});

describe('«Когда принимать»: time of day and meal', () => {
  it('splits and joins the old one field', () => {
    expect(splitWhen('evening')).toEqual({ time: 'evening', meal: null });
    expect(splitWhen('empty_stomach')).toEqual({ time: null, meal: 'empty_stomach' });
    expect(splitWhen('any')).toEqual({ time: null, meal: null });
    expect(joinWhen('morning', 'with_fat')).toBe('morning');
    expect(joinWhen(null, 'with_fat')).toBe('with_food');
    expect(joinWhen('any', null)).toBe('any');
    expect(joinWhen(null, null)).toBeNull();
  });

  it('the new fields win; an old rule reads its one field', () => {
    const old = { when_a: 'morning', when_b: 'with_food', time_a: null, meal_a: null, time_b: null, meal_b: null };
    expect(ruleTiming(old)).toEqual({ a: { time: 'morning', meal: null }, b: { time: null, meal: 'with_food' } });
    const fresh = { ...old, time_a: 'morning', meal_a: 'with_fat' };
    expect(timingText(ruleTiming(fresh).a, 'ru')).toBe('Утро, с жирной едой');
    expect(timingText({ time: null, meal: 'empty_stomach' }, 'ru')).toBe('Натощак');
  });

  it('the editor writes time and meal and keeps the old field in step', () => {
    expect(timingColumns({ time_a: 'morning', meal_a: 'with_fat' })).toEqual({ time_a: 'morning', meal_a: 'with_fat', when_a: 'morning' });
    const before = { when_a: 'morning', when_b: null, time_a: 'morning', meal_a: 'with_fat', time_b: null, meal_b: null };
    expect(timingColumns({ meal_a: null }, before)).toEqual({ time_a: 'morning', meal_a: null, when_a: 'morning' });
    expect(timingColumns({ when_b: 'evening' })).toEqual({ when_b: 'evening', time_b: 'evening', meal_b: null });
  });

  it('the master table keeps a finer value while its one field did not change', () => {
    const before = { when_a: 'morning', when_b: 'evening', time_a: 'morning', meal_a: 'with_fat', time_b: 'evening', meal_b: null };
    expect(whenColumns('morning', 'day', before)).toEqual({ time_a: 'morning', meal_a: 'with_fat', time_b: 'day', meal_b: null });
    expect(whenColumns('with_food', null)).toEqual({ time_a: null, meal_a: 'with_food', time_b: null, meal_b: null });
  });
});
