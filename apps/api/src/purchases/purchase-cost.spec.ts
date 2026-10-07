import { allocateLineTotals, derivePurchaseStatus, largestRemainder, purchaseProgress, unitCostRange, unitCosts } from './purchase-cost';

const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);
const line = (ordered: number, price: number, cancelled = 0) => ({ ordered_qty: ordered, cancelled_qty: cancelled, unit_price_original_uzs: price });

describe('purchase cost allocation', () => {
  it('without a final total every line costs its base = (ordered - cancelled) × price', () => {
    expect(allocateLineTotals([line(10, 1500), line(3, 999, 1)], null)).toEqual([15_000n, 1_998n]);
  });

  it('a final total LOWER than the lines is spread proportionally and matches exactly', () => {
    const lines = [line(10, 10_000), line(5, 4_000), line(1, 3_333)]; // bases 100 000 + 20 000 + 3 333 = 123 333
    const res = allocateLineTotals(lines, 100_000);
    expect(sum(res)).toBe(100_000n);
    // exact shares 81 081.30 / 16 216.26 / 2 702.44 -> floors 99 999, the 1 UZS left goes to the largest remainder (.44)
    expect(res).toEqual([81_081n, 16_216n, 2_703n]);
  });

  it('a final total HIGHER than the lines (fees) is spread the same way', () => {
    const res = allocateLineTotals([line(2, 50_000), line(1, 50_000)], 160_001);
    expect(sum(res)).toBe(160_001n);
    expect(res).toEqual([106_667n, 53_334n]); // 106 667.33 + 53 333.67 -> the extra UZS to the largest remainder (.67)
  });

  it('rounding never loses or invents a single UZS, whatever the numbers', () => {
    for (let seed = 1; seed < 200; seed++) {
      const lines = Array.from({ length: (seed % 7) + 1 }, (_, i) => {
        const ordered = ((seed * (i + 3)) % 17) + 2; // at least 2, so one cancelled unit still leaves something
        return line(ordered, (seed * 7919 * (i + 1)) % 250_001, i % 3 === 0 ? 1 : 0);
      });
      const final = (seed * 104_729) % 3_000_000;
      expect(sum(allocateLineTotals(lines, final))).toBe(BigInt(final));
    }
  });

  it('ties go to the earlier line; equal bases share equally', () => {
    expect(largestRemainder(10n, [1n, 1n, 1n])).toEqual([4n, 3n, 3n]);
    expect(largestRemainder(9n, [1n, 1n, 1n])).toEqual([3n, 3n, 3n]);
  });

  it('a cancellation changes the bases, so the totals are recalculated; a fully cancelled line gets 0', () => {
    const before = allocateLineTotals([line(4, 10_000), line(4, 10_000)], 70_000);
    expect(before).toEqual([35_000n, 35_000n]);
    const after = allocateLineTotals([line(4, 10_000, 2), line(4, 10_000)], 70_000);
    expect(after).toEqual([23_333n, 46_667n]); // 23 333.33 + 46 666.67
    expect(allocateLineTotals([line(4, 10_000, 4), line(4, 10_000)], 70_000)).toEqual([0n, 70_000n]);
  });

  it('all prices 0: the final total is spread by quantity; nothing left anywhere -> zeros', () => {
    expect(allocateLineTotals([line(3, 0), line(1, 0)], 1_000)).toEqual([750n, 250n]);
    expect(allocateLineTotals([line(3, 0, 3)], 1_000)).toEqual([0n]);
    expect(() => allocateLineTotals([line(1, 1)], -1)).toThrow();
  });
});

describe('unit costs', () => {
  it('floor per unit, the remaining UZS +1 on the first units, Σ = line total', () => {
    expect(unitCosts(10_001, 3)).toEqual([3_334n, 3_334n, 3_333n]);
    expect(sum(unitCosts(81_082, 10))).toBe(81_082n);
    expect(unitCosts(500, 0)).toEqual([]);
    expect(unitCostRange(10_001, 3)).toEqual({ min: 3_333, max: 3_334 });
    expect(unitCostRange(null, 3)).toBeNull();
  });
});

describe('progress and status', () => {
  const l = (ordered: number, cancelled: number, received: number) => ({ ordered_qty: ordered, cancelled_qty: cancelled, received_qty: received });
  it('received / ordered, remaining and «отменена полностью» are computed', () => {
    expect(purchaseProgress([l(10, 2, 3), l(5, 0, 6)])).toEqual({ ordered: 15, cancelled: 2, received: 9, expected: 13, remaining: 5, fully_cancelled: false });
    expect(purchaseProgress([l(2, 2, 0), l(1, 1, 0)]).fully_cancelled).toBe(true);
  });
  it('RECEIVED only when nothing is expected and something arrived', () => {
    expect(derivePurchaseStatus([l(2, 0, 0)])).toBe('EXPECTED');
    expect(derivePurchaseStatus([l(2, 2, 0)])).toBe('EXPECTED'); // fully cancelled is not «received»
    expect(derivePurchaseStatus([l(2, 1, 1), l(3, 0, 4)])).toBe('RECEIVED');
    expect(derivePurchaseStatus([])).toBe('EXPECTED');
  });
});
