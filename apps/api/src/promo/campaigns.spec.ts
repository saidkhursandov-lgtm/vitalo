import { CAMPAIGN_MAX_PCT, campaignState, checkTarget, discountPctOf, effectivePrice, OPEN_END, periodsOverlap, targetPrice } from './campaigns';
import { eligibleLines, goodsDiscount, PricingLine, PROMO_GUARD_DEFAULT } from './pricing';
import { campaignLines } from './promo.service';

const guard = PROMO_GUARD_DEFAULT; // 10% markup over the cost; 20% max without a cost
const at = (s: string) => new Date(s);

describe('3.7 sales: price of a product in a sale', () => {
  it('a percent gives a price rounded UP to 100 sum, a fixed price is taken as is', () => {
    expect(targetPrice(133_900, { discount_pct: 15, campaign_price_uzs: null })).toBe(113_900); // 113 815 → 113 900
    expect(targetPrice(100_000, { discount_pct: null, campaign_price_uzs: 79_990 })).toBe(79_990);
    expect(discountPctOf(100_000, 79_990)).toBe(20);
  });

  it('D-28: up to 35% with an end date; D-09: up to 25% without one; exact, not the rounded badge', () => {
    const cost = 40_000;
    expect(checkTarget(100_000, cost, { discount_pct: 35, campaign_price_uzs: null }, guard, false).problem).toBeNull();
    expect(checkTarget(100_000, cost, { discount_pct: 36, campaign_price_uzs: null }, guard, false).problem).toBe('too_big');
    expect(checkTarget(100_000, cost, { discount_pct: null, campaign_price_uzs: 64_999 }, guard, false).problem).toBe('too_big');
    expect(checkTarget(100_000, cost, { discount_pct: 25, campaign_price_uzs: null }, guard, true).problem).toBeNull();
    expect(checkTarget(100_000, cost, { discount_pct: 26, campaign_price_uzs: null }, guard, true)).toMatchObject({ problem: 'too_big', max_pct: 25 });
    expect(CAMPAIGN_MAX_PCT).toBe(35);
  });

  it('margin floor: cost × 1.10; without a cost — at most 20% from the settings', () => {
    // cost 70 000 → floor 77 000: 25% (75 000) is below it
    expect(checkTarget(100_000, 70_000, { discount_pct: 25, campaign_price_uzs: null }, guard, false)).toMatchObject({ problem: 'below_margin', floor_uzs: 77_000 });
    expect(checkTarget(100_000, 70_000, { discount_pct: null, campaign_price_uzs: 77_000 }, guard, false).problem).toBeNull();
    // no cost: 20% is the most, even though the sale allows 35%
    expect(checkTarget(100_000, null, { discount_pct: 20, campaign_price_uzs: null }, guard, false).problem).toBeNull();
    expect(checkTarget(100_000, null, { discount_pct: 21, campaign_price_uzs: null }, guard, false)).toMatchObject({ problem: 'below_margin', floor_uzs: 80_000 });
  });

  it('refuses no discount, both or neither of % / price', () => {
    expect(checkTarget(100_000, null, { discount_pct: null, campaign_price_uzs: 100_000 }, guard, false).problem).toBe('no_discount');
    expect(checkTarget(100_000, null, { discount_pct: 10, campaign_price_uzs: 90_000 }, guard, false).problem).toBe('bad_value');
    expect(checkTarget(100_000, null, { discount_pct: null, campaign_price_uzs: null }, guard, false).problem).toBe('bad_value');
  });

  it('at sale time the margin floor wins when the cost grew after the save; no discount left — regular price', () => {
    expect(effectivePrice(100_000, 40_000, { discount_pct: 30, campaign_price_uzs: null }, guard)).toEqual({ price_uzs: 70_000, discount_pct: 30 });
    expect(effectivePrice(100_000, 70_000, { discount_pct: 30, campaign_price_uzs: null }, guard)).toEqual({ price_uzs: 77_000, discount_pct: 23 });
    expect(effectivePrice(100_000, 95_000, { discount_pct: 30, campaign_price_uzs: null }, guard)).toBeNull();
  });
});

describe('3.7 sales: dates', () => {
  const p = { status: 'active', start_at: at('2026-11-11T00:00:00+05:00'), end_at: at('2026-11-12T00:00:00+05:00') };
  it('runs by the clock: scheduled → running → ended; switched off = disabled', () => {
    expect(campaignState(p, at('2026-11-10T23:59:59+05:00'))).toBe('scheduled');
    expect(campaignState(p, at('2026-11-11T00:00:00+05:00'))).toBe('running');
    expect(campaignState(p, at('2026-11-12T00:00:00+05:00'))).toBe('ended'); // the end itself is outside
    expect(campaignState({ ...p, status: 'disabled' }, at('2026-11-11T12:00:00+05:00'))).toBe('disabled');
    expect(campaignState({ ...p, end_at: OPEN_END }, at('2030-01-01T00:00:00Z'))).toBe('running');
  });

  it('one product — one sale: overlap is any shared moment, touching ends do not overlap', () => {
    const next = { start_at: at('2026-11-12T00:00:00+05:00'), end_at: at('2026-11-13T00:00:00+05:00') };
    expect(periodsOverlap(p, next)).toBe(false);
    expect(periodsOverlap(p, { ...next, start_at: at('2026-11-11T23:00:00+05:00') })).toBe(true);
  });
});

describe('3.7 sales and promo codes (D-39: one discount module)', () => {
  const line = (id: string, price: number, extra: Partial<PricingLine> = {}): PricingLine => ({ product_id: id, brand_id: null, qty: 1, unit_price_uzs: price, old_price_uzs: null, cost_uzs: null, ...extra });
  const all = { scope: 'order' as const, product_ids: [], brand_ids: [] };

  it('a promo code skips products in a sale above 15% and applies to a sale of 15% or less', () => {
    const lines = [line('bf', 70_000, { list_price_uzs: 100_000, campaign_pct: 30 }), line('mild', 90_000, { list_price_uzs: 100_000, campaign_pct: 10 }), line('plain', 50_000)];
    expect(eligibleLines(lines, all).map((l) => l.product_id)).toEqual(['mild', 'plain']);
  });

  it('a sale of 35% is not «hidden» like a Market old price: still excluded', () => {
    expect(eligibleLines([line('a', 65_000, { old_price_uzs: 100_000, list_price_uzs: 100_000, campaign_pct: 35 })], all)).toEqual([]);
  });

  it('without a cost, sale + promo together stay inside the 20% of the regular price', () => {
    // regular 100 000, sale 10% → 90 000; a 20% code may take only 10 000 more (floor 80 000 from the regular price)
    const g = goodsDiscount('percent', 20, [line('a', 90_000, { list_price_uzs: 100_000, campaign_pct: 10 })], guard);
    expect(g.total_uzs).toBe(10_000);
    expect(g.capped).toBe(true);
  });

  it('«Акция 11.11: −X сум» — one line per sale, summed over its products and quantities', () => {
    const sale = { id: 'c1', title_ru: '11.11', title_uz: null, skin: 'eleven_eleven', discount_pct: 20 };
    expect(
      campaignLines([
        { product_id: 'a', qty: 2, unit_price_uzs: 80_000, list_price_uzs: 100_000, campaign: sale },
        { product_id: 'b', qty: 1, unit_price_uzs: 40_000, list_price_uzs: 50_000, campaign: sale },
        { product_id: 'c', qty: 1, unit_price_uzs: 30_000 },
      ]),
    ).toEqual([{ promotion_id: 'c1', title_ru: '11.11', title_uz: null, skin: 'eleven_eleven', amount_uzs: 50_000 }]);
  });
});
