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
  /** Bot API 6.9+: asks the user to share their phone with the bot. */
  requestContact?(cb: (shared: boolean, res?: { responseUnsafe?: { contact?: { phone_number?: string } } }) => void): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback?: { notificationOccurred(type: 'error' | 'success' | 'warning'): void; impactOccurred?(style: 'light' | 'medium' | 'heavy'): void };
  /** Bot API 8.0+: the location with Telegram's own permission dialog. */
  LocationManager?: {
    isInited: boolean;
    isLocationAvailable: boolean;
    isAccessRequested: boolean;
    isAccessGranted: boolean;
    init(cb?: () => void): void;
    getLocation(cb: (data: { latitude: number; longitude: number } | null) => void): void;
  };
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
export const BRAND_COLORS = { header: '#ffffff', background: '#f5f7fa', bottomBar: '#ffffff' } as const;

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

/**
 * "Поделиться номером из Telegram": the phone goes to our bot (it saves it for the user); the answer may
 * already carry the number. Returns the shared number, null if declined, undefined if not supported.
 */
export function requestPhone(): Promise<string | null | undefined> {
  const app = telegram();
  if (!app?.requestContact || !app.isVersionAtLeast('6.9')) return Promise.resolve(undefined);
  return new Promise((resolve) => app.requestContact!((shared, res) => resolve(shared ? (res?.responseUnsafe?.contact?.phone_number ?? '') : null)));
}

export const canRequestPhone = () => !!telegram()?.requestContact && !!telegram()?.isVersionAtLeast('6.9');

export type LocationResult = { status: 'ok'; lat: number; lon: number } | { status: 'denied' } | { status: 'unavailable' };

const LOCATION_TIMEOUT_MS = 15_000;

/**
 * 3.6: «Моё местоположение» on the map. Inside Telegram (8.0+) — Telegram's LocationManager with its own permission
 * dialog; elsewhere (and in older Telegram) — the browser. Never throws; a refusal is 'denied'.
 */
export function getLocation(): Promise<LocationResult> {
  const lm = telegram()?.LocationManager;
  if (lm && telegram()!.isVersionAtLeast('8.0')) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'unavailable' }), LOCATION_TIMEOUT_MS);
      const done = (r: LocationResult) => {
        clearTimeout(timer);
        resolve(r);
      };
      const ask = () => {
        if (!lm.isLocationAvailable) return done({ status: 'unavailable' });
        if (lm.isAccessRequested && !lm.isAccessGranted) return done({ status: 'denied' });
        lm.getLocation((data) =>
          done(data ? { status: 'ok', lat: data.latitude, lon: data.longitude } : { status: lm.isAccessGranted ? 'unavailable' : 'denied' }),
        );
      };
      if (lm.isInited) ask();
      else lm.init(ask);
    });
  }
  return browserLocation();
}

function browserLocation(): Promise<LocationResult> {
  if (!('geolocation' in navigator)) return Promise.resolve({ status: 'unavailable' });
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ status: 'ok', lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => resolve({ status: e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: LOCATION_TIMEOUT_MS, maximumAge: 60_000 },
    ),
  );
}

/** A light tap (quick add, quantity change). */
export function tapHaptic() {
  telegram()?.HapticFeedback?.impactOccurred?.('light');
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
