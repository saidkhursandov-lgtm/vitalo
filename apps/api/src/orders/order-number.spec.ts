import { formatUzs, tashkentDateString } from '../common/tashkent';
import { formatOrderNumber } from './order-number';

describe('order number', () => {
  it('formats VTL-YYYYMMDD-NNNN', () => {
    expect(formatOrderNumber('2026-10-02', 1)).toBe('VTL-20261002-0001');
    expect(formatOrderNumber('2026-10-02', 123)).toBe('VTL-20261002-0123');
    expect(formatOrderNumber('2026-10-02', 12345)).toBe('VTL-20261002-12345'); // grows instead of overflowing
  });

  it('uses the Tashkent calendar date, not UTC', () => {
    expect(tashkentDateString(new Date('2026-10-02T18:59:59Z'))).toBe('2026-10-02'); // 23:59 Tashkent
    expect(tashkentDateString(new Date('2026-10-02T19:00:00Z'))).toBe('2026-10-03'); // 00:00 Tashkent
  });
});

describe('formatUzs', () => {
  it('groups thousands with spaces', () => {
    expect(formatUzs(0)).toBe('0');
    expect(formatUzs(25000)).toBe('25 000');
    expect(formatUzs(1234567)).toBe('1 234 567');
  });
});
