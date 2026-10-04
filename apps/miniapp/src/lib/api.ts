/** Thin fetch wrapper for apps/api. In dev, /api is proxied to localhost:3000 by Vite. */
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';
const TOKEN_KEY = 'vitalo.token';

/** Error with the API's machine-readable `code` (e.g. INSUFFICIENT_STOCK) and the full body. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly body: Record<string, unknown>,
  ) {
    super(typeof body.message === 'string' ? body.message : `HTTP ${status}`);
  }
}

/** Every request gives up after this long: on a slow network no button stays "hanging". */
export const REQUEST_TIMEOUT_MS = 15_000;
/** No answer at all (timeout, connection lost): status 0 and one of these codes. */
export const NETWORK_CODES = ['NETWORK_TIMEOUT', 'NETWORK_ERROR'] as const;
export const isNetworkError = (e: unknown) => e instanceof ApiError && e.status === 0;

/** The connection banner listens here: true = a request failed without an answer, false = an answer came. */
type NetListener = (offline: boolean) => void;
const netListeners = new Set<NetListener>();
export function onNetworkChange(fn: NetListener): () => void {
  netListeners.add(fn);
  return () => netListeners.delete(fn);
}
const emitNet = (offline: boolean) => netListeners.forEach((fn) => fn(offline));

let token: string | null = readStoredToken();
let onUnauthorized: (() => void) | null = null;

function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(value: string | null) {
  token = value;
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage may be blocked; the in-memory token still works for this page */
  }
}

export const hasToken = () => token !== null;

export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  let body: Record<string, unknown>;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
        ...(token && { authorization: `Bearer ${token}` }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  } catch {
    emitNet(true);
    throw new ApiError(0, controller.signal.aborted ? 'NETWORK_TIMEOUT' : 'NETWORK_ERROR', {});
  } finally {
    clearTimeout(timer);
  }
  emitNet(false);
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    if (res.status === 401 && token) {
      setToken(null);
      onUnauthorized?.();
    }
    throw new ApiError(res.status, typeof body.code === 'string' ? body.code : undefined, body);
  }
  return body as T;
}

/** Query string from an object, skipping empty values; arrays are joined with commas. */
export function qs(params: Record<string, string | number | boolean | string[] | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
