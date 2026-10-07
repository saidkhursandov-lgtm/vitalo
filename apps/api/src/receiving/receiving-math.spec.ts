import { formatPhysicalId, normalizePhysicalId } from './physical-id';
import { checkExpiryGroups, distribute, groupExpiries, lineUnitCosts, parseDay, ruDay, unitExpiries } from './receiving-math';

describe('Physical ID', () => {
  it('V- and the number with zeros to 6 digits; longer numbers as they are', () => {
    expect(formatPhysicalId(184)).toBe('V-000184');
    expect(formatPhysicalId(1)).toBe('V-000001');
    expect(formatPhysicalId(999_999)).toBe('V-999999');
    expect(formatPhysicalId(1_000_000)).toBe('V-1000000');
    expect(() => formatPhysicalId(0)).toThrow();
  });

  it('V-000184, v-000184, 000184 and 184 are one ID (also from a scanner with the Russian layout)', () => {
    for (const typed of ['V-000184', 'v-000184', ' 000184 ', '184', 'V000184', 'v184', 'М-000184', 'м-000184', 'V–000184']) {
      expect(normalizePhysicalId(typed)).toBe('V-000184');
    }
    for (const bad of ['', 'V-', '0', 'VTL-OMEGA3', 'A-000184', '12a', 'V--184']) expect(normalizePhysicalId(bad)).toBeNull();
  });
});

describe('expiry dates', () => {
  it('ДД.ММ.ГГГГ or YYYY-MM-DD, only real dates', () => {
    expect(parseDay('31.12.2027')).toBe('2027-12-31');
    expect(parseDay('1.2.2028')).toBe('2028-02-01');
    expect(parseDay('2027-12-31')).toBe('2027-12-31');
    expect(parseDay('31.02.2027')).toBeNull();
    expect(parseDay('2027/12/31')).toBeNull();
    expect(ruDay('2027-12-31')).toBe('31.12.2027');
  });

  it('groups: required, not in the past, Σ = accepted quantity, short ones (< 90 days) reported', () => {
    const today = '2026-10-09';
    expect(checkExpiryGroups([{ expiry: '01.11.2026', qty: 2 }, { expiry: '2028-01-01', qty: 3 }, { expiry: '01.11.2026', qty: 1 }], 6, today)).toEqual({
      groups: [{ expiry: '2026-11-01', qty: 3 }, { expiry: '2028-01-01', qty: 3 }],
      short: [{ expiry: '2026-11-01', qty: 3 }],
    });
    expect(checkExpiryGroups([{ expiry: '08.10.2026', qty: 1 }], 1, today)).toEqual({ problem: { code: 'EXPIRY_IN_PAST', expiry: '2026-10-08' } });
    expect(checkExpiryGroups([{ expiry: '09.10.2026', qty: 1 }], 1, today)).toMatchObject({ groups: [{ expiry: '2026-10-09', qty: 1 }] }); // today is fine
    expect(checkExpiryGroups([{ expiry: '2028-01-01', qty: 2 }], 3, today)).toEqual({ problem: { code: 'EXPIRY_QTY_MISMATCH', total: 2 } });
    expect(checkExpiryGroups([{ expiry: 'скоро', qty: 1 }], 1, today)).toEqual({ problem: { code: 'EXPIRY_INVALID', value: 'скоро' } });
    expect(checkExpiryGroups([], 1, today)).toEqual({ problem: { code: 'EXPIRY_QTY_MISMATCH', total: 0 } });
  });

  it('per-unit expiries and back', () => {
    const days = unitExpiries([{ expiry: '2027-01-01', qty: 2 }, { expiry: '2028-01-01', qty: 1 }]);
    expect(days).toEqual(['2027-01-01', '2027-01-01', '2028-01-01']);
    expect(groupExpiries(days.slice(1))).toEqual([{ expiry: '2027-01-01', qty: 1 }, { expiry: '2028-01-01', qty: 1 }]);
  });
});

describe('spreading an accepted quantity over the purchases of a source', () => {
  it('oldest purchase first, each line up to what it still expects', () => {
    expect(distribute(7, [{ open: 3 }, { open: 0 }, { open: 5 }])).toEqual([
      { index: 0, qty: 3, over: 0 },
      { index: 2, qty: 4, over: 0 },
    ]);
  });

  it('above everything expected: the rest goes to the last line as a discrepancy', () => {
    expect(distribute(10, [{ open: 3 }, { open: 5 }])).toEqual([
      { index: 0, qty: 3, over: 0 },
      { index: 1, qty: 7, over: 2 },
    ]);
    expect(distribute(2, [{ open: 0 }, { open: 0 }])).toEqual([{ index: 1, qty: 2, over: 2 }]);
    expect(distribute(2, [])).toEqual([]);
  });
});

describe('unit costs of a line', () => {
  it('k-th unit gets the k-th share; Σ = allocated total exactly when everything expected arrived', () => {
    const costs = lineUnitCosts(81_081n, 10, 10);
    expect(costs.reduce((s, c) => s + c, 0n)).toBe(81_081n);
    expect(costs[0]).toBe(8_109n);
    expect(costs[9]).toBe(8_108n);
    expect(lineUnitCosts(81_081n, 10, 3)).toEqual([8_109n, 8_108n, 8_108n]);
  });

  it('units above the expected quantity get the rounded average', () => {
    expect(lineUnitCosts(10_001n, 2, 4)).toEqual([5_001n, 5_000n, 5_001n, 5_001n]); // 5000.5 -> 5001
    expect(lineUnitCosts(10_000n, 3, 4)[3]).toBe(3_333n);
    expect(lineUnitCosts(0n, 0, 2)).toEqual([0n, 0n]); // everything was cancelled
  });
});
