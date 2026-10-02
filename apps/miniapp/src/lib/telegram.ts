/** Minimal typing of the parts of Telegram.WebApp we use (https://core.telegram.org/bots/webapps). */
interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { user?: { language_code?: string } };
  version: string;
  colorScheme: 'light' | 'dark';
  ready(): void;
  expand(): void;
  isVersionAtLeast(version: string): boolean;
  showConfirm(message: string, callback: (ok: boolean) => void): void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback?: { notificationOccurred(type: 'error' | 'success' | 'warning'): void };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/** The WebApp object only when we are really inside Telegram (the SDK script also loads in a browser). */
export function telegram(): TelegramWebApp | null {
  const app = window.Telegram?.WebApp;
  return app && app.initData ? app : null;
}

export function initTelegram() {
  const app = telegram();
  if (!app) return;
  app.ready();
  app.expand();
  document.documentElement.classList.add('in-telegram');
}

export function confirmDialog(message: string): Promise<boolean> {
  const app = telegram();
  if (app?.isVersionAtLeast('6.2')) {
    return new Promise((resolve) => app.showConfirm(message, resolve));
  }
  return Promise.resolve(window.confirm(message));
}

export function haptic(type: 'error' | 'success' | 'warning') {
  telegram()?.HapticFeedback?.notificationOccurred(type);
}
