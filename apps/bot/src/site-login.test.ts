import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import type { VitaloApi } from './api-client';
import { siteLoginHandler } from './site-login';

const ctx = (lang = 'ru') => {
  const reply = vi.fn().mockResolvedValue(undefined);
  return { c: { from: { id: 42, first_name: 'Азиз', language_code: lang }, reply } as unknown as Context, reply };
};
const HEX = 'a'.repeat(32);

describe('site login from /start login_<id>', () => {
  it('passes the Telegram account to the API and answers in the customer language', async () => {
    const customerLogin = vi.fn().mockResolvedValue({ result: 'approved', lang: 'uz' });
    const { c, reply } = ctx();
    expect(await siteLoginHandler({ customerLogin } as unknown as VitaloApi)(c, `login_${HEX}`)).toBe(true);
    expect(customerLogin).toHaveBeenCalledWith(HEX, expect.objectContaining({ id: 42, first_name: 'Азиз' }));
    expect(reply.mock.calls[0][0]).toContain('tasdiqlandi');
  });

  it('ignores other payloads (referral codes, receipts)', async () => {
    const customerLogin = vi.fn();
    const { c, reply } = ctx();
    expect(await siteLoginHandler({ customerLogin } as unknown as VitaloApi)(c, 'REF123')).toBe(false);
    expect(await siteLoginHandler({ customerLogin } as unknown as VitaloApi)(c, 'login_xyz')).toBe(false);
    expect(customerLogin).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('says it failed when the API is down', async () => {
    const { c, reply } = ctx();
    await siteLoginHandler({ customerLogin: vi.fn().mockRejectedValue(new Error('down')) } as unknown as VitaloApi)(c, `login_${HEX}`);
    expect(reply.mock.calls[0][0]).toContain('Не получилось');
  });
});
