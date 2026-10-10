import { buildHealth, maxSyncAgeMinutes } from './health';

const now = new Date('2026-10-20T10:00:00Z');
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const base = { dbOk: true, syncEnabled: true, intervalMinutes: 5, lastSyncAt: ago(3), startedAt: ago(600), now };

describe('health report', () => {
  it('ok: the database answers and the last poll is fresh', () => {
    expect(buildHealth(base)).toEqual({ status: 'ok', time: now.toISOString(), db: true, yandex_sync: { enabled: true, minutes_since_last: 3, max_minutes: 20, stale: false } });
  });

  it('degraded: the poll is on and older than three intervals + 5 minutes', () => {
    expect(maxSyncAgeMinutes(5)).toBe(20);
    expect(buildHealth({ ...base, lastSyncAt: ago(20) }).status).toBe('ok');
    expect(buildHealth({ ...base, lastSyncAt: ago(21) })).toMatchObject({ status: 'degraded', yandex_sync: { stale: true, minutes_since_last: 21 } });
  });

  it('the poll is off (local computer after the move, or before it is switched on): its age does not matter', () => {
    expect(buildHealth({ ...base, syncEnabled: false, lastSyncAt: ago(5000) })).toMatchObject({ status: 'ok', yandex_sync: { enabled: false, minutes_since_last: null, stale: false } });
  });

  it('no run yet: counted from the start of the process (fresh start is fine, a long silence is not)', () => {
    expect(buildHealth({ ...base, lastSyncAt: null, startedAt: ago(2) }).status).toBe('ok');
    expect(buildHealth({ ...base, lastSyncAt: null, startedAt: ago(60) }).status).toBe('degraded');
  });

  it('down: the database does not answer', () => {
    expect(buildHealth({ ...base, dbOk: false })).toMatchObject({ status: 'down', db: false });
  });

  it('nothing secret or internal in the answer', () => {
    expect(Object.keys(buildHealth(base)).sort()).toEqual(['db', 'status', 'time', 'yandex_sync']);
  });
});
