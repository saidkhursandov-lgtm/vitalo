import { dailyAverage, landedCost, purchaseSignals, SIGNAL_DEFAULTS, type SnapshotPoint } from './purchase-signals';

const now = new Date('2026-11-09T12:00:00Z'); // 17:00 Tashkent
const at = (daysAgo: number, hourUtc = 5) => new Date(Date.UTC(2026, 10, 9 - daysAgo, hourUtc));
const pt = (daysAgo: number, price: number, extra: Partial<SnapshotPoint> = {}): SnapshotPoint => ({ taken_at: at(daysAgo), price_uzs: price, weight_kg: 0.2, in_stock: true, ...extra });

describe('purchase signals (D-57, 09.11)', () => {
  it('landed cost = price + weight × rate', () => {
    expect(landedCost(200_000, 0.25, 0)).toBe(200_000);
    expect(landedCost(200_000, 0.25, 40_000)).toBe(210_000);
    expect(landedCost(200_000, null, 40_000)).toBe(200_000);
  });

  it('the 30-day average is by days: three uploads in a day weigh as one day', () => {
    const pts = [pt(2, 100_000), { ...pt(2, 100_000), taken_at: at(2, 10) }, { ...pt(2, 100_000), taken_at: at(2, 16) }, pt(1, 200_000), pt(40, 1_000_000)];
    expect(dailyAverage(pts, 0, now)).toEqual({ avg: 150_000, days: 2 });
  });

  it('rule A: −10% and more = buy, −15% and more = strong; needs 3 days and iHerb in stock', () => {
    const hist = [pt(5, 200_000), pt(4, 200_000), pt(3, 200_000)];
    // average of 4 days with today 178 000 = 194 500 → −8.5%: nothing
    expect(purchaseSignals([...hist, pt(0, 178_000)], null, SIGNAL_DEFAULTS, now).signals).toEqual([]);
    // today 170 000 → avg 192 500 → −11.7%
    const a = purchaseSignals([...hist, pt(0, 170_000)], null, SIGNAL_DEFAULTS, now);
    expect(a.avg30_uzs).toBe(192_500);
    expect(a.signals.map((s) => [s.kind, s.pct])).toEqual([['iherb_buy', 11.7]]);
    // today 150 000 → avg 187 500 → −20%
    expect(purchaseSignals([...hist, pt(0, 150_000)], null, SIGNAL_DEFAULTS, now).signals[0].kind).toBe('iherb_strong');
    // out of stock on iHerb: no signal A
    expect(purchaseSignals([...hist, pt(0, 150_000, { in_stock: false })], null, SIGNAL_DEFAULTS, now).signals).toEqual([]);
    // two days of history only
    expect(purchaseSignals([pt(1, 200_000), pt(0, 150_000)], null, SIGNAL_DEFAULTS, now).signals).toEqual([]);
  });

  it('rule B: local ≤ landed = urgent; up to +7% = intercept; more = nothing', () => {
    const p = [pt(0, 200_000)];
    expect(purchaseSignals(p, { price_uzs: 199_000, where: 'Fitvibe' }, SIGNAL_DEFAULTS, now).signals.map((s) => s.kind)).toEqual(['local_urgent']);
    expect(purchaseSignals(p, { price_uzs: 214_000, where: 'Fitvibe' }, SIGNAL_DEFAULTS, now).signals.map((s) => [s.kind, s.pct])).toEqual([['local_intercept', 7]]);
    expect(purchaseSignals(p, { price_uzs: 215_000, where: 'Fitvibe' }, SIGNAL_DEFAULTS, now).signals).toEqual([]);
    // shipping makes iHerb dearer: 200 000 + 0.2 kg × 50 000 = 210 000 → 205 000 locally is cheaper
    const r = purchaseSignals(p, { price_uzs: 205_000, where: 'BioBox' }, { ...SIGNAL_DEFAULTS, shipping_rate_per_kg_uzs: 50_000 }, now);
    expect(r.landed_uzs).toBe(210_000);
    expect(r.signals[0].kind).toBe('local_urgent');
  });

  it('no iHerb snapshot = nothing to compare', () => {
    expect(purchaseSignals([], { price_uzs: 1000, where: 'x' }, SIGNAL_DEFAULTS, now)).toEqual({ landed_uzs: null, weight_missing: false, avg30_uzs: null, avg_days: 0, signals: [] });
  });
});
