import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadTelegramWebApp, openedFromTelegram } from './lib/telegram-webapp';

describe('telegram-web-app.js only inside Telegram (аудит 2.16)', () => {
  it('is not in index.html any more', () => {
    expect(readFileSync('index.html', 'utf8')).not.toContain('telegram-web-app.js');
  });
  it('the bot opens the panel with tgWebAppData in the address; an ordinary browser has none', () => {
    const w = (hash: string, extra: object = {}) => ({ location: { hash }, ...extra }) as unknown as Window;
    expect(openedFromTelegram(w('#tgWebAppData=query_id%3D1&tgWebAppVersion=8.0'))).toBe(true);
    expect(openedFromTelegram(w('', { TelegramWebviewProxy: {} }))).toBe(true);
    expect(openedFromTelegram(w(''))).toBe(false);
  });
  it('outside Telegram nothing is loaded', async () => {
    await loadTelegramWebApp();
    expect(document.querySelector('script[src*="telegram-web-app"]')).toBeNull();
  });
});
