import { PricingLine, PROMO_GUARD_DEFAULT } from '../promo/pricing';
import { BONUS_DEFAULT, bonusSpend, cashbackOf, normalizeBonusSettings } from './bonus-rules';

const line = (id: string, price: number, qty = 1, extra: Partial<PricingLine> = {}): PricingLine => ({
  product_id: id,
  brand_id: null,
  qty,
  unit_price_uzs: price,
  old_price_uzs: null,
  cost_uzs: Math.round(price / 2), // a usual markup: the 25% cap decides, not the margin floor
  ...extra,
});
const spend = (balance: number, lines: PricingLine[], o: { promo?: boolean; use?: boolean; settings?: Partial<typeof BONUS_DEFAULT> } = {}) =>
  bonusSpend({ balance_uzs: balance, lines, guard: PROMO_GUARD_DEFAULT, settings: { ...BONUS_DEFAULT, ...o.settings }, promoApplied: !!o.promo, use: o.use ?? true });

describe('3.10-А bonus rules (D-71)', () => {
  it('without a purchase cost the floor is −20% of the price (promo guard)', () => {
    expect(spend(1_000_000, [line('a', 200_000, 1, { cost_uzs: null })]).used_uzs).toBe(40_000);
  });

  it('pays at most 25% of the goods, in whole hundreds', () => {
    const r = spend(1_000_000, [line('a', 100_000), line('b', 50_350)]);
    expect(r.available_uzs).toBe(37_500); // 25% of 150 350 = 37 587 → 37 500
    expect(r.used_uzs).toBe(37_500);
    expect([...r.lines.values()].reduce((s, v) => s + v, 0)).toBe(37_500);
  });

  it('never more than the balance', () => {
    expect(spend(12_345, [line('a', 200_000)]).used_uzs).toBe(12_300);
  });

  it('switch off: shows what may be spent, spends nothing', () => {
    const r = spend(50_000, [line('a', 200_000)], { use: false });
    expect(r).toMatchObject({ available_uzs: 50_000, used_uzs: 0, blocked: null });
  });

  it('not together with a promo code', () => {
    expect(spend(50_000, [line('a', 200_000)], { promo: true })).toMatchObject({ used_uzs: 0, blocked: 'promo' });
  });

  it('a line with a sale above 15% takes no bonuses; only such lines — blocked', () => {
    const sale = line('s', 80_000, 1, { campaign_pct: 20, list_price_uzs: 100_000 });
    expect(spend(50_000, [sale])).toMatchObject({ used_uzs: 0, blocked: 'big_sale' });
    const r = spend(50_000, [sale, line('a', 40_000)]);
    expect(r.used_uzs).toBe(10_000); // 25% of 40 000
    expect(r.lines.get('s') ?? 0).toBe(0);
  });

  it('the margin floor of a line cuts the bonuses', () => {
    // cost 95 000, markup 10% → floor 104 500: only 5 500 of room → 5 500
    const r = spend(50_000, [line('a', 110_000, 1, { cost_uzs: 95_000 })]);
    expect(r.used_uzs).toBe(5_500);
    expect(spend(50_000, [line('a', 104_500, 1, { cost_uzs: 95_000 })])).toMatchObject({ used_uzs: 0, blocked: 'margin' });
  });

  it('off, or less than 100 on the balance', () => {
    expect(spend(50_000, [line('a', 200_000)], { settings: { enabled: false } }).blocked).toBe('disabled');
    expect(spend(99, [line('a', 200_000)]).blocked).toBe('empty');
  });

  it('cashback: the percent of the goods really paid, whole sum down', () => {
    expect(cashbackOf(52_300, 3)).toBe(1_569);
    expect(cashbackOf(52_300, 0)).toBe(0);
    expect(cashbackOf(0, 3)).toBe(0);
  });

  it('settings: wrong values fall back to the default', () => {
    expect(normalizeBonusSettings({ cashback_pct: 50, max_spend_pct: 30, lifetime_days: 5, enabled: false })).toEqual({ ...BONUS_DEFAULT, max_spend_pct: 30, enabled: false });
    expect(normalizeBonusSettings(null)).toEqual(BONUS_DEFAULT);
  });
});
