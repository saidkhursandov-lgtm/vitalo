import { quietUntil } from './notification-worker';

describe('3.2: marketing quiet hours 22:00–08:00 Tashkent (UTC+5)', () => {
  it('daytime: send now', () => {
    expect(quietUntil(new Date('2026-11-01T03:00:00Z'))).toBeNull(); // 08:00 Tashkent
    expect(quietUntil(new Date('2026-11-01T16:59:00Z'))).toBeNull(); // 21:59
  });
  it('evening: the next morning 08:00; night after midnight: the same morning', () => {
    expect(quietUntil(new Date('2026-11-01T17:00:00Z'))).toEqual(new Date('2026-11-02T03:00:00Z')); // 22:00 -> 08:00 next day
    expect(quietUntil(new Date('2026-11-01T21:30:00Z'))).toEqual(new Date('2026-11-02T03:00:00Z')); // 02:30 -> 08:00
    expect(quietUntil(new Date('2026-11-01T02:59:00Z'))).toEqual(new Date('2026-11-01T03:00:00Z')); // 07:59 -> 08:00
  });
});
