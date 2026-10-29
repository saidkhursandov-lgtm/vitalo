import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api, ApiError } from './api';
import { applyCart } from './cart-cache';
import { useCart } from './queries';
import type { Cart } from './types';

/**
 * Quick cart (F1): the quantity a customer wants for each product, shown at once on every card
 * (optimistic), sent to the server after a short pause so fast taps become one request, rolled back on refusal.
 * The server cart (query ['cart', null]) stays the source of truth; `desired` only holds unsent changes.
 * The cart counter (badge, floating cart, sum) always comes from the server's answer, never from a local guess.
 */
export const QUICK_DEBOUNCE_MS = 300;
export const MAX_LINE_QTY = 99;

const desired = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export type QuickNotice = { kind: 'left'; n: number } | { kind: 'error'; code?: string };
type Notify = (n: QuickNotice) => void;

const serverLine = (cart: Cart | undefined, productId: string) => cart?.items.find((i) => i.product_id === productId && i.status === 'available');

// ---------------------------------------------------------------- changes

async function flush(client: QueryClient, productId: string, notify: Notify) {
  timers.delete(productId);
  if (inFlight.has(productId)) {
    // one request per product at a time; the newest wish goes right after
    timers.set(productId, setTimeout(() => void flush(client, productId, notify), QUICK_DEBOUNCE_MS));
    return;
  }
  const target = desired.get(productId);
  if (target === undefined) return;
  const cart = client.getQueryData<Cart>(['cart', null]);
  const server = serverLine(cart, productId)?.qty ?? 0;
  if (target === server) {
    desired.delete(productId);
    emit();
    return;
  }
  inFlight.add(productId);
  try {
    const res =
      target === 0
        ? await api<Cart>(`/cart/items/${productId}`, { method: 'DELETE' })
        : server === 0
          ? await api<Cart>('/cart/items', { method: 'POST', body: { product_id: productId, qty: target } })
          : await api<Cart>(`/cart/items/${productId}`, { method: 'PATCH', body: { qty: target } });
    // our own "qty reduced" is answered by the toast, not repeated on the cart screen
    applyCart(client, res, (w) => w.code === 'qty_reduced' && w.product_id === productId);
    if (desired.get(productId) === target) {
      desired.delete(productId);
      const got = serverLine(res, productId)?.qty ?? 0;
      if (got < target) notify({ kind: 'left', n: got });
    }
  } catch (e) {
    // refused: the wish is dropped; the badge never moved, and it is read from the server again to be sure
    desired.delete(productId);
    void client.invalidateQueries({ queryKey: ['cart', 'count'] });
    notify({ kind: 'error', code: e instanceof ApiError ? e.code : undefined });
  } finally {
    inFlight.delete(productId);
    emit();
  }
}

function change(client: QueryClient, productId: string, next: number, notify: Notify) {
  const cart = client.getQueryData<Cart>(['cart', null]);
  const prev = desired.get(productId) ?? serverLine(cart, productId)?.qty ?? 0;
  if (next === prev) return;
  desired.set(productId, next);
  // Only the number on the product control is optimistic. The badge in the top bar, the floating cart and its sum are
  // never guessed: they are written from the server's answer (applyCart), so a refused add cannot leave them wrong.
  emit();
  clearTimeout(timers.get(productId));
  timers.set(productId, setTimeout(() => void flush(client, productId, notify), QUICK_DEBOUNCE_MS));
}

/** Quantity of one product in the cart, the same on every card, with a setter that answers instantly. */
export function useQuickCart(productId: string, notify: Notify) {
  const client = useQueryClient();
  const cart = useCart(null);
  useSyncExternalStore(subscribe, () => version);
  const line = serverLine(cart.data, productId);
  const qty = desired.get(productId) ?? line?.qty ?? 0;
  const max = line ? Math.min(line.available_qty, MAX_LINE_QTY) : MAX_LINE_QTY;
  return {
    qty,
    max,
    ready: !cart.isPending,
    set: (n: number) => change(client, productId, Math.max(0, Math.min(n, max)), notify),
  };
}

/** Tests only. */
export function resetQuickCart() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  desired.clear();
  inFlight.clear();
  emit();
}
