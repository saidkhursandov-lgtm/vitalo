import { matchOneToOne, type MatchValues } from './one-to-one';

const ours: MatchValues = { brand: 'California Gold Nutrition', match_form: 'бисглицинат', dose_amount: 200, dose_unit: 'mg', dose_per: 'capsule', pack_count: 90 };

describe('«1-в-1» match (D-57, узел 4)', () => {
  it('the same product: brand spelled differently, the dose in other units', () => {
    expect(matchOneToOne(ours, { ...ours, brand: 'california gold', match_form: '  Бисглицинат ', dose_amount: 0.2, dose_unit: 'g' })).toEqual({ status: 'match', reasons: [] });
    expect(matchOneToOne({ ...ours, dose_amount: 25, dose_unit: 'mcg' }, { ...ours, dose_amount: 0.025, dose_unit: 'mg' }).status).toBe('match');
  });

  it('one difference = «не тот товар», with the reason in words', () => {
    expect(matchOneToOne(ours, { ...ours, brand: 'NOW Foods' })).toEqual({ status: 'mismatch', reasons: ['бренд: California Gold Nutrition / NOW Foods'] });
    expect(matchOneToOne(ours, { ...ours, match_form: 'цитрат', pack_count: 120 })).toEqual({ status: 'mismatch', reasons: ['форма: бисглицинат / цитрат', 'в банке: 90 / 120'] });
    expect(matchOneToOne(ours, { ...ours, dose_amount: 100 }).reasons).toEqual(['доза: 200 мг на капсула / 100 мг на капсула']);
    expect(matchOneToOne(ours, { ...ours, dose_per: 'tablet' }).status).toBe('mismatch');
    expect(matchOneToOne(ours, { ...ours, dose_unit: 'iu' }).status).toBe('mismatch');
    // a short brand is not a prefix match
    expect(matchOneToOne({ ...ours, brand: 'NOW' }, { ...ours, brand: 'Nowell' }).status).toBe('mismatch');
  });

  it('a value missing on either side = not compared', () => {
    expect(matchOneToOne({ ...ours, match_form: null, pack_count: null }, ours)).toEqual({ status: 'incomplete', reasons: ['у товара VITALO не заполнено: химическая форма, количество в банке'] });
    expect(matchOneToOne(ours, { ...ours, dose_per: null })).toEqual({ status: 'incomplete', reasons: ['у конкурента не указано: доза'] });
  });
});
