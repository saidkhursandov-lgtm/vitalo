import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPaymentLink } from './lib/telegram';

const URL_ = 'https://checkout.paycom.uz/abc';

function inTelegram(platform: string) {
  const openLink = vi.fn();
  window.Telegram = { WebApp: { initData: 'x', platform, openLink } as never };
  return openLink;
}

afterEach(() => {
  delete window.Telegram;
  vi.unstubAllGlobals();
});

describe('openPaymentLink: the payment page in the phone browser, so the Payme / Click app can open', () => {
  it('Android → Chrome, iPhone → Safari, desktop Telegram → as is', () => {
    let open = inTelegram('android');
    openPaymentLink(URL_);
    expect(open).toHaveBeenCalledWith(URL_, { try_instant_view: false, try_browser: 'chrome' });
    open = inTelegram('ios');
    openPaymentLink(URL_);
    expect(open).toHaveBeenCalledWith(URL_, { try_instant_view: false, try_browser: 'safari' });
    open = inTelegram('tdesktop');
    openPaymentLink(URL_);
    expect(open).toHaveBeenCalledWith(URL_, { try_instant_view: false });
  });

  it('outside Telegram: a new tab; pop-ups blocked (in-app web views) → this tab goes there', () => {
    const win = { opener: {} };
    const open = vi.fn(() => win);
    vi.stubGlobal('open', open);
    openPaymentLink(URL_);
    expect(open).toHaveBeenCalledWith(URL_, '_blank');
    expect(win.opener).toBeNull();

    const assign = vi.fn();
    vi.stubGlobal('open', vi.fn(() => null));
    vi.stubGlobal('location', { ...window.location, assign });
    openPaymentLink(URL_);
    expect(assign).toHaveBeenCalledWith(URL_);
  });
});
