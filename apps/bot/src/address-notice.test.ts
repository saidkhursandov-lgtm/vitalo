import { describe, expect, it } from 'vitest';
import { noticeKeyboard, noticeText, notifyNewAddresses, pickRecipients, urlsChanged, type Recipient, type TunnelUrls } from './address-notice';

const OLD: TunnelUrls = { miniapp: 'https://old-shop.trycloudflare.com', admin: 'https://old-admin.trycloudflare.com' };
const NEW: TunnelUrls = { miniapp: 'https://new-shop.trycloudflare.com', admin: 'https://new-admin.trycloudflare.com' };

describe('urlsChanged', () => {
  it('first run (nothing announced yet) -> announce', () => expect(urlsChanged(null, NEW)).toBe(true));
  it('same addresses (API or bot restarted, tunnel not) -> no message', () => expect(urlsChanged({ ...NEW }, NEW)).toBe(false));
  it('either address changed -> announce', () => {
    expect(urlsChanged(OLD, NEW)).toBe(true);
    expect(urlsChanged({ ...NEW, admin: OLD.admin }, NEW)).toBe(true);
    expect(urlsChanged({ ...NEW, miniapp: OLD.miniapp }, NEW)).toBe(true);
  });
  it('no Mini App address yet -> nothing to announce', () => expect(urlsChanged(OLD, { miniapp: null, admin: NEW.admin })).toBe(false));
});

describe('pickRecipients', () => {
  it('only admins and managers, each once; other roles, customers and bad ids are dropped', () => {
    const list: Recipient[] = [
      { telegram_id: '111', role: 'admin' },
      { telegram_id: '222', role: 'manager' },
      { telegram_id: '111', role: 'admin' },
      { telegram_id: '333', role: 'warehouse' },
      { telegram_id: '444', role: 'marketer' },
      { telegram_id: '555', role: 'customer' },
      { telegram_id: '12abc', role: 'admin' },
    ];
    expect(pickRecipients(list)).toEqual(['111', '222']);
  });
});

describe('notice', () => {
  it('two web_app buttons with the current addresses', () => {
    const rows = noticeKeyboard(NEW).inline_keyboard.flat();
    expect(rows).toEqual([
      { text: 'Открыть админку', web_app: { url: `${NEW.admin}/` } },
      { text: 'Открыть магазин', web_app: { url: `${NEW.miniapp}/` } },
    ]);
    expect(noticeText(NEW)).toContain('Новые адреса VITALO');
    expect(noticeText(NEW)).toContain(NEW.admin);
    expect(noticeText(NEW)).not.toContain('old-');
  });
});

/** In-memory fakes: what was sent, what is stored, what was logged. */
function harness(opts: { last?: TunnelUrls | null; recipients?: () => Promise<Recipient[]>; failFor?: string[] } = {}) {
  const sent: { chat: string | number; text: string; buttons: unknown }[] = [];
  const logs: string[] = [];
  let stored: TunnelUrls | null = opts.last ?? null;
  const deps = {
    api: {
      sendMessage: async (chat: string | number, text: string, other?: { reply_markup?: unknown }) => {
        if (opts.failFor?.includes(String(chat))) throw new Error("Call to 'sendMessage' failed! (403: Forbidden: bot can't initiate conversation with a user)");
        sent.push({ chat, text, buttons: other?.reply_markup });
        return {} as never;
      },
    },
    recipients: opts.recipients ?? (async () => [{ telegram_id: '111', role: 'admin' }, { telegram_id: '222', role: 'manager' }, { telegram_id: '333', role: 'warehouse' }]),
    readLast: () => stored,
    writeLast: (u: TunnelUrls) => void (stored = u),
    log: (l: string) => void logs.push(l),
    tries: 3,
    waitMs: 0,
  };
  return { deps, sent, logs, stored: () => stored };
}

describe('notifyNewAddresses', () => {
  it('new addresses: admins and managers get one message each; the pair is remembered', async () => {
    const h = harness({ last: OLD });
    await notifyNewAddresses(NEW, h.deps);
    expect(h.sent.map((s) => s.chat)).toEqual(['111', '222']);
    expect(h.stored()).toEqual(NEW);
  });

  it('same addresses again: nothing is sent (no duplicates on restarts)', async () => {
    const h = harness({ last: OLD });
    await notifyNewAddresses(NEW, h.deps);
    await notifyNewAddresses(NEW, h.deps);
    expect(h.sent).toHaveLength(2);
    expect(h.logs.join('\n')).toContain('не изменились');
  });

  it('a failed send (never wrote to the bot) is logged and does not stop the others', async () => {
    const h = harness({ failFor: ['111'] });
    await expect(notifyNewAddresses(NEW, h.deps)).resolves.toBeUndefined();
    expect(h.sent.map((s) => s.chat)).toEqual(['222']);
    expect(h.logs.join('\n')).toMatch(/111: .*403/);
    expect(h.stored()).toEqual(NEW);
  });

  it('API still starting: retried; when it never answers nothing is sent or remembered, and nothing throws', async () => {
    let calls = 0;
    const flaky = harness({ recipients: async () => (++calls < 3 ? Promise.reject(new Error('fetch failed')) : [{ telegram_id: '111', role: 'admin' }]) });
    await notifyNewAddresses(NEW, flaky.deps);
    expect(flaky.sent).toHaveLength(1);

    const down = harness({ recipients: async () => Promise.reject(new Error('fetch failed')) });
    await expect(notifyNewAddresses(NEW, down.deps)).resolves.toBeUndefined();
    expect(down.sent).toHaveLength(0);
    expect(down.stored()).toBeNull();
    expect(down.logs.join('\n')).toContain('не отправлено');
  });

  it('customers are never messaged, even if the API returned them by mistake', async () => {
    const h = harness({ recipients: async () => [{ telegram_id: '960000002', role: 'customer' }, { telegram_id: '111', role: 'admin' }] });
    await notifyNewAddresses(NEW, h.deps);
    expect(h.sent.map((s) => s.chat)).toEqual(['111']);
  });
});
