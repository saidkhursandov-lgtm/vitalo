import { isTashkentWorkingHours } from './tashkent';

// Tashkent is UTC+5: 08:00 there is 03:00 UTC, 22:00 there is 17:00 UTC.
describe('isTashkentWorkingHours (8:00–22:00 Tashkent)', () => {
  it.each([
    ['2026-10-29T03:00:00Z', true, '08:00 — the first working minute'],
    ['2026-10-29T10:30:00Z', true, '15:30'],
    ['2026-10-29T16:59:00Z', true, '21:59 — the last working minute'],
    ['2026-10-29T17:00:00Z', false, '22:00 — already night'],
    ['2026-10-29T21:00:00Z', false, '02:00 the next day'],
    ['2026-10-29T02:59:00Z', false, '07:59 — still night'],
  ])('%s -> %s (%s)', (iso, expected) => {
    expect(isTashkentWorkingHours(new Date(iso))).toBe(expected);
  });
});
