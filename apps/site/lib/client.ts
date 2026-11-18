'use client';
import type { Cart, UserProfile } from './types';

/** The browser talks to the API through /api on the same domain (nginx on the server, a rewrite in dev). */
const TOKEN_KEY = 'vitalo.site.token';
const GUEST_CART_KEY = 'vitalo.site.guestCart';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly body: Record<string, unknown>,
  ) {
    super(typeof body.message === 'string' ? body.message : `HTTP ${status}`);
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked: this page still works */
  }
}

export const getToken = () => read(TOKEN_KEY);
export const setToken = (v: string | null) => write(TOKEN_KEY, v);

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: (() => void) | null) => {
  onUnauthorized = fn;
};

export async function api<T>(path: string, opts: { method?: string; body?: unknown; auth?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  const token = opts.auth === false ? null : getToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', {});
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized?.();
    throw new ApiError(res.status, typeof body.code === 'string' ? body.code : undefined, body);
  }
  return body as T;
}

export interface WebSession {
  token: string;
  user: UserProfile;
}

/* ---------- Guest cart: before sign-in the cart lives in this browser ---------- */

export interface GuestLine {
  product_id: string;
  qty: number;
}

export function readGuestCart(): GuestLine[] {
  try {
    const raw = JSON.parse(read(GUEST_CART_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((l): l is GuestLine => !!l && typeof l.product_id === 'string' && Number.isInteger(l.qty) && l.qty > 0);
  } catch {
    return [];
  }
}

export function writeGuestCart(lines: GuestLine[]) {
  const clean = lines.filter((l) => l.qty > 0).slice(0, 50);
  write(GUEST_CART_KEY, clean.length ? JSON.stringify(clean) : null);
}

/** Adds to a guest line (the same as POST /cart/items on the server: the quantity grows). */
export function addToGuestCart(lines: GuestLine[], productId: string, qty: number): GuestLine[] {
  const found = lines.find((l) => l.product_id === productId);
  if (found) return lines.map((l) => (l.product_id === productId ? { ...l, qty: Math.min(99, l.qty + qty) } : l));
  return [...lines, { product_id: productId, qty: Math.min(99, qty) }];
}

export function setGuestQty(lines: GuestLine[], productId: string, qty: number): GuestLine[] {
  return qty <= 0 ? lines.filter((l) => l.product_id !== productId) : lines.map((l) => (l.product_id === productId ? { ...l, qty: Math.min(99, qty) } : l));
}

/**
 * After sign-in: every guest line goes into the account cart (the one the Mini App shows). A product that is gone or out
 * of stock is skipped — the rest still moves. Returns the number of lines that moved.
 */
export async function mergeGuestCart(): Promise<number> {
  const lines = readGuestCart();
  let moved = 0;
  for (const l of lines) {
    try {
      await api<Cart>('/cart/items', { method: 'POST', body: { product_id: l.product_id, qty: l.qty } });
      moved++;
    } catch {
      /* skip this line */
    }
  }
  writeGuestCart([]);
  return moved;
}
