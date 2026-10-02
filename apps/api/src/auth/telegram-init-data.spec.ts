import { createHmac } from 'crypto';
import { validateInitData, InitDataError } from './telegram-init-data';

const BOT = '123456:TEST_TOKEN';

function sign(fields: Record<string, string>, token = BOT) {
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const now = 1_800_000_000;
const user = JSON.stringify({ id: 42, first_name: 'Ali' });

describe('validateInitData', () => {
  it('accepts valid data', () => {
    const d = sign({ auth_date: String(now), user, start_param: 'REF123' });
    const r = validateInitData(d, BOT, 3600, now);
    expect(r.user.id).toBe(42);
    expect(r.start_param).toBe('REF123');
  });

  it('rejects wrong token', () => {
    const d = sign({ auth_date: String(now), user }, 'other:token');
    expect(() => validateInitData(d, BOT, 3600, now)).toThrow(InitDataError);
  });

  it('rejects tampered payload', () => {
    const d = sign({ auth_date: String(now), user }).replace('Ali', 'Eve');
    expect(() => validateInitData(d, BOT, 3600, now)).toThrow(InitDataError);
  });

  it('rejects expired data', () => {
    const d = sign({ auth_date: String(now - 7200), user });
    expect(() => validateInitData(d, BOT, 3600, now)).toThrow('expired');
  });

  it('rejects malformed user JSON with InitDataError', () => {
    const d = sign({ auth_date: String(now), user: '{not json' });
    expect(() => validateInitData(d, BOT, 3600, now)).toThrow(InitDataError);
  });

  it('rejects missing hash', () => {
    expect(() => validateInitData('auth_date=1', BOT)).toThrow(InitDataError);
  });
});
