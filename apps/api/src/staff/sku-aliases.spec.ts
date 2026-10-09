import { isSkuLike, skuProblem } from './sku-aliases';

describe('alternative SKU: what counts as a code', () => {
  it('letters-only, digits-only and mixed codes with . _ / - are fine', () => {
    for (const ok of ['MRKT-VNQUDOHD', 'mrkt-vnqudohd', 'TPRD-031', 'OZN-A001', '123456', 'YM.OLD_1/2', 'AB']) expect(skuProblem(ok)).toBeNull();
    expect(isSkuLike('A'.repeat(64))).toBe(true);
  });

  it('really bad values are refused with the real reason', () => {
    expect(skuProblem('')).toBe('пустое значение');
    expect(skuProblem('MRKT VNQUDOHD')).toContain('пробел');
    expect(skuProblem('OZN-A001\t')).toContain('пробел');
    expect(skuProblem('НА ЯНДЕКС ЕЩЁ НЕ ВЫСТАВЛЕН')).toContain('пробел');
    expect(skuProblem('ОЗН-А001')).toContain('кириллица');
    expect(skuProblem('OZN-А001')).toContain('кириллица'); // one Cyrillic «А» among latin letters
    expect(skuProblem('OZN#001')).toBe('недопустимый символ «#» — можно только латиницу, цифры и . _ / -');
    expect(skuProblem('---')).toBe('нет ни одной буквы или цифры');
    expect(skuProblem('A')).toContain('короче 2');
    expect(skuProblem('A'.repeat(65))).toContain('длиннее 64');
  });
});
