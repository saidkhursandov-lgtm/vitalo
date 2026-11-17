import { goodsDiscount, PricingLine, PROMO_GUARD_DEFAULT } from '../promo/pricing';
import { bundleDays, bundleDiscount, bundleMargin, BundleRule } from './bundles';

const guard = { min_markup_pct: 10, max_discount_pct: 20 };
const line = (id: string, price: number, qty = 1, extra: Partial<PricingLine> = {}): PricingLine => ({
  product_id: id,
  brand_id: null,
  qty,
  unit_price_uzs: price,
  old_price_uzs: null,
  cost_uzs: Math.round(price * 0.5),
  ...extra,
});
const set = (id: string, items: string[], pct = 10): BundleRule => ({ id, title_ru: `Сет ${id}`, title_uz: null, discount_pct: pct, items: items.map((product_id) => ({ product_id, qty: 1 })) });

describe('4.3 скидка сета в корзине', () => {
  it('the full set gets its discount; without one product — none', () => {
    const lines = [line('d3', 100_000), line('k2', 150_000), line('zinc', 80_000)];
    const d = bundleDiscount(lines, [set('a', ['d3', 'k2'])], guard);
    expect(d.total_uzs).toBe(25_000);
    expect(d.lines.get('d3')! + d.lines.get('k2')!).toBe(25_000);
    expect(d.lines.has('zinc')).toBe(false);
    expect(d.applied).toEqual([{ bundle_id: 'a', title_ru: 'Сет a', title_uz: null, times: 1, amount_uzs: 25_000 }]);
    expect(bundleDiscount([line('d3', 100_000)], [set('a', ['d3', 'k2'])], guard).total_uzs).toBe(0);
  });

  it('two jars of each → two sets; two sets never share a jar', () => {
    expect(bundleDiscount([line('d3', 100_000, 2), line('k2', 100_000, 2)], [set('a', ['d3', 'k2'])], guard).applied[0].times).toBe(2);
    // one D3 for two sets: only the first gets it
    const two = bundleDiscount([line('d3', 100_000), line('k2', 100_000), line('mg', 100_000)], [set('a', ['d3', 'k2']), set('b', ['d3', 'mg'], 5)], guard);
    expect(two.applied.map((a) => a.bundle_id)).toEqual(['a']);
    // with two D3 both sets count
    expect(bundleDiscount([line('d3', 100_000, 2), line('k2', 100_000), line('mg', 100_000)], [set('a', ['d3', 'k2']), set('b', ['d3', 'mg'], 5)], guard).total_uzs).toBe(30_000);
  });

  it('a jar in a sale above 15% gets no set discount; the margin floor caps a line', () => {
    const sale = line('k2', 80_000, 1, { list_price_uzs: 100_000, campaign_pct: 20 });
    const d = bundleDiscount([line('d3', 100_000), sale], [set('a', ['d3', 'k2'])], guard);
    expect(d.total_uzs).toBe(10_000);
    expect(d.lines.get('k2')).toBe(0);
    // cost 95 000 + 10% = 104 500 > price: no room at all
    expect(bundleDiscount([line('d3', 100_000, 1, { cost_uzs: 95_000 }), line('k2', 100_000, 1, { cost_uzs: 95_000 })], [set('a', ['d3', 'k2'])], guard).total_uzs).toBe(0);
  });

  it('a promo code after the set takes only what is left above the margin floor', () => {
    // cost 80 000 → floor 88 000; the set takes 10 000 of the 12 000 room per jar, the promo — 2 000 at most
    const lines = [line('d3', 100_000, 1, { cost_uzs: 80_000 }), line('k2', 100_000, 1, { cost_uzs: 80_000 })];
    const d = bundleDiscount(lines, [set('a', ['d3', 'k2'])], guard);
    expect(d.total_uzs).toBe(20_000);
    const promo = goodsDiscount('percent', 20, lines.map((l) => ({ ...l, taken_uzs: d.lines.get(l.product_id) })), PROMO_GUARD_DEFAULT);
    expect(promo.total_uzs).toBe(4_000);
    expect(promo.capped).toBe(true);
  });
});

describe('4.3 маржа сета в админке', () => {
  it('the price with the discount and the margin; below 30% or without a cost — not saved', () => {
    const ok = bundleMargin([{ price_uzs: 100_000, cost_uzs: 50_000, qty: 1 }, { price_uzs: 150_000, cost_uzs: 75_000, qty: 1 }], 10);
    expect(ok).toEqual({ list_total_uzs: 250_000, sale_total_uzs: 225_000, cost_total_uzs: 125_000, margin_pct: 44.4, too_low: false });
    expect(bundleMargin([{ price_uzs: 100_000, cost_uzs: 68_000, qty: 1 }, { price_uzs: 100_000, cost_uzs: 68_000, qty: 1 }], 5).too_low).toBe(true);
    expect(bundleMargin([{ price_uzs: 100_000, cost_uzs: null, qty: 1 }, { price_uzs: 100_000, cost_uzs: 10_000, qty: 1 }], 5)).toMatchObject({ cost_total_uzs: null, margin_pct: null, too_low: true });
  });

  it('«Хватит на X дней» — the shortest course', () => {
    expect(bundleDays([{ qty: 1, pack_count: 60, servings_per_day: 1 }, { qty: 1, pack_count: 90, servings_per_day: 3 }])).toBe(30);
    expect(bundleDays([{ qty: 1, pack_count: 60, servings_per_day: null }])).toBeNull();
  });
});
