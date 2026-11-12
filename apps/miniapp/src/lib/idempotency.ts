/**
 * One Idempotency-Key per distinct order attempt: retrying the same form (double tap, network error)
 * reuses the key, so the API returns the already created order; changing the form gets a new key.
 *
 * Аудит админки 2.2: the key is also kept in sessionStorage for a short while, so the same form sent again after the
 * checkout screen was opened anew (back button, reload, the Telegram window restored) still gets the same key and does
 * not create a second order. After REUSE_MS the same cart may be ordered again on purpose.
 */
const STORAGE_KEY = 'vitalo.checkout.idempotency';
export const REUSE_MS = 2 * 60_000;

type Saved = { fingerprint: string; key: string; at: number };

function read(storage: Storage | null): Saved | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}
function write(storage: Storage | null, saved: Saved) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    /* private mode or storage blocked: the key lives in memory only */
  }
}
function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function createIdempotencyKeys(storage: Storage | null = sessionStore(), now: () => number = Date.now) {
  let last: Saved | null = read(storage);
  return {
    keyFor(body: unknown): string {
      const fingerprint = JSON.stringify(body);
      if (!last || last.fingerprint !== fingerprint || now() - last.at > REUSE_MS) last = { fingerprint, key: crypto.randomUUID(), at: now() };
      else last = { ...last, at: now() }; // every retry keeps the key alive for another REUSE_MS
      write(storage, last);
      return last.key;
    },
  };
}
