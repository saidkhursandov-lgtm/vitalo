import { audienceFits, pickPair, ruleBetween, type PairProduct, type PairRule } from './pair';

const p = (id: string, subs: string[], extra: Partial<PairProduct> = {}): PairProduct => ({
  id,
  audience: 'adult',
  substances: new Set(subs),
  label: new Set(subs),
  popularity: 0,
  price: 100_000,
  ...extra,
});
const rules: PairRule[] = [
  { a: 'd3', b: 'k2', text_ru: 'D3 и K2 дополняют друг друга', text_uz: 'D3 va K2' },
  { a: 'collagen', b: 'c', text_ru: 'C нужен для коллагена', text_uz: 'C kollagen uchun' },
];

describe('4.1 «Идеальная пара»', () => {
  it('a product with one substance of a rule gets a product with the other one', () => {
    expect(pickPair(p('d3', ['d3']), [p('k2', ['k2']), p('c', ['c'])], rules)).toEqual({ product_id: 'k2', rule: rules[0] });
    // the rule works in both directions
    expect(pickPair(p('k2', ['k2']), [p('d3', ['d3'])], rules)?.product_id).toBe('d3');
  });

  it('the pair must not repeat what the product gives: коллаген + C does not get коллаген + гиалурон', () => {
    const r: PairRule[] = [{ a: 'collagen', b: 'ha', text_ru: '', text_uz: '' }];
    expect(pickPair(p('colc', ['collagen', 'c']), [p('colha', ['collagen', 'ha']), p('ha', ['ha'], { popularity: -1 })], r)?.product_id).toBe('ha');
    expect(pickPair(p('colc', ['collagen', 'c']), [p('colha', ['collagen', 'ha'])], r)).toBeNull();
  });

  it('the rule needs a main substance of the product too: a little D3 in a protein shake asks for no K2', () => {
    expect(pickPair(p('prot', ['protein', 'd3'], { label: new Set(['protein']) }), [p('k2', ['k2'])], rules)).toBeNull();
  });

  it('both substances in one jar: no pair from that rule', () => {
    expect(pickPair(p('d3k2', ['d3', 'k2']), [p('k2', ['k2']), p('d3', ['d3'])], rules)).toBeNull();
  });

  it('only with the substance in the label; then the best seller, then the cheaper one', () => {
    const multi = p('multi', ['c', 'zinc'], { label: new Set(['zinc']), popularity: 99 });
    const c1 = p('c1', ['c'], { popularity: 5, price: 200_000 });
    const c2 = p('c2', ['c'], { popularity: 5, price: 150_000 });
    const c3 = p('c3', ['c'], { popularity: 1, price: 50_000 });
    expect(pickPair(p('col', ['collagen']), [multi, c1, c2, c3], rules)?.product_id).toBe('c2');
    expect(pickPair(p('col', ['collagen']), [multi], rules)).toBeNull();
  });

  it('a child product pairs only with a child one, an adult one never with a child one', () => {
    const kidK2 = p('kidk2', ['k2'], { audience: 'child' });
    const k2 = p('k2', ['k2'], { audience: 'any' });
    expect(pickPair(p('kidd3', ['d3'], { audience: 'child' }), [k2, kidK2], rules)?.product_id).toBe('kidk2');
    expect(pickPair(p('d3', ['d3']), [kidK2], rules)).toBeNull();
    expect(audienceFits({ audience: 'any' }, { audience: 'adult' })).toBe(true);
    expect(audienceFits({ audience: null }, { audience: 'child' })).toBe(false);
  });

  it('never itself; no rule → no pair', () => {
    expect(pickPair(p('d3', ['d3']), [p('d3', ['d3', 'k2'])], rules)).toBeNull();
    expect(pickPair(p('zinc', ['zinc']), [p('k2', ['k2'])], rules)).toBeNull();
  });

  it('a pair chosen by hand finds the rule joining it, if any', () => {
    expect(ruleBetween(p('a', ['c']), p('b', ['collagen']), rules)).toBe(rules[1]);
    expect(ruleBetween(p('a', ['zinc']), p('b', ['k2']), rules)).toBeNull();
  });
});
