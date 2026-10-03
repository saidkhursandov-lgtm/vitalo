/** Minimal typing of the parts of Telegram.WebApp we use (https://core.telegram.org/bots/webapps). */
interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { user?: { language_code?: string }; start_param?: string };
  version: string;
  colorScheme: 'light' | 'dark';
  ready(): void;
  expand(): void;
  isVersionAtLeast(version: string): boolean;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
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

/** Brand colours for Telegram's own header and background (the Mini App is light only). */
export const BRAND_COLORS = { header: '#ffffff', background: '#f3f5f4', bottomBar: '#ffffff' } as const;

export function initTelegram() {
  const app = telegram();
  if (!app) return;
  app.ready();
  app.expand();
  try {
    if (app.isVersionAtLeast('6.1')) {
      app.setHeaderColor?.(BRAND_COLORS.header);
      app.setBackgroundColor?.(BRAND_COLORS.background);
    }
    if (app.isVersionAtLeast('7.10')) app.setBottomBarColor?.(BRAND_COLORS.bottomBar);
  } catch {
    // Old Telegram clients: keep their default colours.
  }
  document.documentElement.classList.add('in-telegram');
}

export function haptic(type: 'error' | 'success' | 'warning') {
  telegram()?.HapticFeedback?.notificationOccurred(type);
}

const REFERRAL_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Referral code: signed start_param from Telegram, else ?startapp= added by the bot to the Mini App link. */
export function startParam(): string | undefined {
  const value = telegram()?.initDataUnsafe.start_param ?? new URLSearchParams(window.location.search).get('startapp') ?? undefined;
  return value && REFERRAL_RE.test(value) ? value : undefined;
}

/** The page was opened on this computer (dev login allowed), not through a public tunnel. */
export function isLocalDevHost(hostname = window.location.hostname): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}
