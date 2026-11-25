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

describe('openPaymentLink: the plain Telegram openLink, so the phone itself opens the Payme / Click app', () => {
  it.each(['android', 'ios', 'tdesktop'])('%s: no browser is forced (try_browser made Android skip the apps)', (platform) => {
    const open = inTelegram(platform);
    openPaymentLink(URL_);
    expect(open).toHaveBeenCalledWith(URL_);
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
