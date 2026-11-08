import { normalizeMatchForm, parseIherbUrl } from './iherb-fields';

describe('iHerb link (D-57)', () => {
  it('takes the product number and drops tracking codes', () => {
    expect(parseIherbUrl('https://uz.iherb.com/pr/california-gold-nutrition-omega-3-100-softgels/62118?rcode=ABC#reviews')).toEqual({
      url: 'https://uz.iherb.com/pr/california-gold-nutrition-omega-3-100-softgels/62118',
      productId: '62118',
    });
    expect(parseIherbUrl(' https://www.iherb.com/pr/now-foods-zinc/2902/ ')).toEqual({ url: 'https://www.iherb.com/pr/now-foods-zinc/2902', productId: '2902' });
    expect(parseIherbUrl('https://iherb.com/pr/103250')?.productId).toBe('103250');
  });

  it('refuses anything that is not an iHerb product page', () => {
    for (const bad of ['http://uz.iherb.com/pr/x/123', 'https://uz.iherb.com/c/vitamins', 'https://evil.com/iherb.com/pr/x/1234', 'https://uz.iherb.com.evil.com/pr/x/1234', 'iherb', '']) {
      expect(parseIherbUrl(bad)).toBeNull();
    }
  });

  it('one spelling of the chemical form', () => {
    expect(normalizeMatchForm('  Бисглицинат   Хелат ')).toBe('бисглицинат хелат');
    expect(normalizeMatchForm('Холекальциферол D3 ёмкий')).toBe('холекальциферол d3 емкий');
  });
});
