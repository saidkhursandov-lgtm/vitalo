/**
 * Аудит админки 2.16: telegram-web-app.js is loaded only when the panel is opened from the bot (Telegram puts
 * `tgWebAppData` into the address, or the app's webview bridge is there). In an ordinary browser (admin.vitalo.uz)
 * nothing is loaded from telegram.org until the login page needs its widget.
 */
const SRC = 'https://telegram.org/js/telegram-web-app.js';

export const openedFromTelegram = (w: Window = window) =>
  /tgWebAppData=/.test(w.location.hash) || 'TelegramWebviewProxy' in w || 'TelegramWebview' in w;

let loading: Promise<void> | null = null;

/** Resolves when window.Telegram.WebApp is ready (or at once outside Telegram); never rejects — sign-in falls back. */
export function loadTelegramWebApp(timeoutMs = 8000): Promise<void> {
  if (window.Telegram?.WebApp || !openedFromTelegram()) return Promise.resolve();
  loading ??= new Promise<void>((resolve) => {
    const done = () => {
      window.Telegram?.WebApp?.ready();
      resolve();
    };
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.onload = done;
    s.onerror = () => resolve();
    setTimeout(resolve, timeoutMs);
    document.head.appendChild(s);
  });
  return loading;
}
