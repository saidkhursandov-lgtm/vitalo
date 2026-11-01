import {
  eligibleLines,
  goodsDiscount,
  lineHeadroom,
  marginWarnings,
  minUnitPrice,
  normalizePromoCode,
  PricingLine,
  PROMO_CODE_RE,
  PROMO_GUARD_DEFAULT,
  splitWhole,
  visibleDiscountPct,
} from './pricing';

const line = (id: string, price: number, qty = 1, extra: Partial<PricingLine> = {}): PricingLine => ({
  product_id: id,
  brand_id: null,
  qty,
  unit_price_uzs: price,
  old_price_uzs: null,
  cost_uzs: null,
  ...extra,
});
const guard = PROMO_GUARD_DEFAULT; // 10% markup, 20% without a cost

describe('3.3 pricing: visible product discount (D-39 А)', () => {
  it('counts only a crossed-out price the customer sees (≤25%)', () => {
    expect(visibleDiscountPct(80_000, 100_000)).toBe(20);
    expect(visibleDiscountPct(75_000, 100_000)).toBe(25);
    expect(visibleDiscountPct(180_000, 315_000)).toBeNull(); // Market «old price» 43% — not shown, not a discount
    expect(visibleDiscountPct(100_000, null)).toBeNull();
  });

  it('a promo skips products with a visible discount above 15%, keeps 15% and hidden Market prices', () => {
    const lines = [
      line('a', 80_000, 1, { old_price_uzs: 100_000 }), // 20% shown → excluded
      line('b', 85_000, 1, { old_price_uzs: 100_000 }), // 15% → allowed
      line('c', 180_000, 1, { old_price_uzs: 315_000 }), // 43% hidden → allowed
    ];
    expect(eligibleLines(lines, { scope: 'order', product_ids: [], brand_ids: [] }).map((l) => l.product_id)).toEqual(['b', 'c']);
  });

  it('brand and product targets', () => {
    const lines = [line('a', 1000, 1, { brand_id: 'B1' }), line('b', 1000, 1, { brand_id: 'B2' })];
    expect(eligibleLines(lines, { scope: 'brand', product_ids: [], brand_ids: ['B2'] }).map((l) => l.product_id)).toEqual(['b']);
    expect(eligibleLines(lines, { scope: 'product', product_ids: ['a'], brand_ids: [] }).map((l) => l.product_id)).toEqual(['a']);
  });
});

describe('3.3 pricing: margin protection', () => {
  it('with a cost: the price never goes below cost + 10% (rounded up)', () => {
    expect(minUnitPrice({ unit_price_uzs: 100_000, cost_uzs: 79_725 }, guard)).toBe(87_698); // 87 697.5 → up
    expect(lineHeadroom(line('a', 100_000, 2, { cost_uzs: 79_725 }), guard)).toBe(2 * 12_302);
  });

  it('without a cost: at most 20% off the line', () => {
    expect(lineHeadroom(line('a', 97_000, 3), guard)).toBe(58_200);
  });

  it('a price already below the floor allows nothing', () => {
    expect(lineHeadroom(line('a', 50_000, 1, { cost_uzs: 50_000 }), guard)).toBe(0);
  });

  it('percent: a line is cut to its floor, the others keep their %', () => {
    const r = goodsDiscount('percent', 30, [line('a', 100_000, 1, { cost_uzs: 80_000 }), line('b', 100_000, 1, { cost_uzs: 10_000 })], guard);
    // a: wants 30 000, floor 88 000 → 12 000; b: 30 000
    expect(r.lines.map((l) => l.discount_uzs)).toEqual([12_000, 30_000]);
    expect(r.lines.map((l) => l.capped)).toEqual([true, false]);
    expect(r.total_uzs).toBe(42_000);
    expect(r.capped).toBe(true);
  });

  it('fixed: what one line cannot take moves to lines with room', () => {
    const r = goodsDiscount('fixed', 30_000, [line('a', 100_000, 1, { cost_uzs: 89_000 }), line('b', 100_000, 1, { cost_uzs: 10_000 })], guard);
    // a: floor 97 900 → room 2 100; b takes the rest
    expect(r.lines.map((l) => l.discount_uzs)).toEqual([2_100, 27_900]);
    expect(r.total_uzs).toBe(30_000);
    expect(r.capped).toBe(false);
  });

  it('fixed: never more than all the room together', () => {
    const r = goodsDiscount('fixed', 50_000, [line('a', 100_000, 1, { cost_uzs: 80_000 })], guard);
    expect(r.total_uzs).toBe(12_000);
    expect(r.capped).toBe(true);
  });

  it('fixed: never more than the goods themselves', () => {
    const r = goodsDiscount('fixed', 500_000, [line('a', 10_000, 1, { cost_uzs: 0 })], guard);
    expect(r.total_uzs).toBe(10_000);
  });

  it('every line at its floor → no discount', () => {
    const r = goodsDiscount('percent', 10, [line('a', 50_000, 1, { cost_uzs: 50_000 })], guard);
    expect(r.total_uzs).toBe(0);
  });

  it('the admin guard is used (markup 50%)', () => {
    const r = goodsDiscount('percent', 20, [line('a', 100_000, 1, { cost_uzs: 60_000 })], { min_markup_pct: 50, max_discount_pct: 20 });
    expect(r.total_uzs).toBe(10_000);
  });
});

describe('3.3 pricing: rounding', () => {
  it('total rounded down to 100 sum and split into whole sums that add up', () => {
    const lines = [line('a', 33_333, 1, { cost_uzs: 1 }), line('b', 33_333, 2, { cost_uzs: 1 }), line('c', 12_345, 3, { cost_uzs: 1 })];
    const r = goodsDiscount('percent', 7, lines, guard);
    // 7% of 137 034 = 9 592.38 → 9 500
    expect(r.total_uzs).toBe(9_500);
    expect(r.lines.reduce((s, l) => s + l.discount_uzs, 0)).toBe(9_500);
    r.lines.forEach((l) => expect(Number.isInteger(l.discount_uzs)).toBe(true));
  });

  it('a 10% code on 200 000 gives exactly 20 000', () => {
    expect(goodsDiscount('percent', 10, [line('a', 120_000, 1), line('b', 80_000, 1)], guard).total_uzs).toBe(20_000);
  });

  it('splitWhole: largest remainder, earlier line wins a tie', () => {
    expect(splitWhole(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitWhole(0, [1, 2])).toEqual([0, 0]);
  });
});

describe('3.3 pricing: admin margin warning', () => {
  it('lists the products where the code would be cut and why', () => {
    const products = [
      { ...line('a', 100_000, 1, { cost_uzs: 80_000 }), sku: 'A', name: 'A' },
      { ...line('b', 100_000, 1, { cost_uzs: 10_000 }), sku: 'B', name: 'B' },
      { ...line('c', 100_000), sku: 'C', name: 'C' },
      { ...line('d', 80_000, 1, { old_price_uzs: 100_000 }), sku: 'D', name: 'D' },
    ];
    expect(marginWarnings('percent', 25, products, guard)).toEqual([
      { product_id: 'a', sku: 'A', name: 'A', wanted_uzs: 25_000, allowed_uzs: 12_000, reason: 'margin' },
      { product_id: 'c', sku: 'C', name: 'C', wanted_uzs: 25_000, allowed_uzs: 20_000, reason: 'no_cost' },
      { product_id: 'd', sku: 'D', name: 'D', wanted_uzs: 20_000, allowed_uzs: 0, reason: 'product_discount' },
    ]);
    expect(marginWarnings('free_delivery', 0, products, guard)).toEqual([]);
  });
});

describe('3.3 promo code text', () => {
  it('case and spaces at the edges do not matter; Latin letters and digits only', () => {
    expect(normalizePromoCode('  vitalo10 ')).toBe('VITALO10');
    expect(PROMO_CODE_RE.test('VITALO10')).toBe(true);
    expect(PROMO_CODE_RE.test('ВИТАЛО')).toBe(false);
    expect(PROMO_CODE_RE.test('VIT ALO')).toBe(false);
  });
});
