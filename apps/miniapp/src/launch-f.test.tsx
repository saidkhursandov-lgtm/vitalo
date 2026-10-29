import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickAdd } from './components/QuickAdd';
import { ToastProvider } from './components/Toast';
import { I18nProvider } from './lib/i18n';
import { QUICK_DEBOUNCE_MS, resetQuickCart, useQuickCart, type QuickNotice } from './lib/quick-cart';
import type { Cart } from './lib/types';

const line = (qty: number, available = 5) => ({
  product_id: 'p1', sku: 'A', name_ru: 'Омега', name_uz: 'Omega', brand: 'X', image_url: null, status: 'available' as const,
  qty, available_qty: available, unit_price_uzs: 1000, line_total_uzs: 1000 * qty,
});
const cart = (qty: number, available = 5): Cart => ({
  items: qty ? [line(qty, available)] : [], warnings: [], goods_total_uzs: 1000 * qty, discount_total_uzs: 0, items_count: qty, can_checkout: qty > 0, delivery: null,
});

let server: { qty: number; available: number; fail?: { status: number; code: string } };
let calls: { method: string; url: string; body?: unknown }[];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  server = { qty: 0, available: 5 };
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });
    if (method !== 'GET' && server.fail) return new Response(JSON.stringify({ code: server.fail.code }), { status: server.fail.status });
    if (method === 'POST') server.qty = Math.min(server.qty + body.qty, server.available);
    if (method === 'PATCH') server.qty = Math.min(body.qty, server.available);
    if (method === 'DELETE') server.qty = 0;
    if (url.endsWith('/cart/count')) return new Response(JSON.stringify({ items_count: server.qty, goods_total_uzs: 1000 * server.qty }));
    return new Response(JSON.stringify(cart(server.qty, server.available)));
  });
});
afterEach(() => {
  resetQuickCart();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider lang="ru" setLang={() => undefined}>
          <ToastProvider>{children}</ToastProvider>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { client, wrapper };
}
const writes = () => calls.filter((c) => c.method !== 'GET');

describe('quick cart (F1)', () => {
  it('answers at once; fast taps become one request; the badge follows', async () => {
    const { client, wrapper } = setup();
    const notices: QuickNotice[] = [];
    const { result } = renderHook(() => useQuickCart('p1', (n) => notices.push(n)), { wrapper });
    await vi.waitFor(() => expect(result.current.ready).toBe(true));
    client.setQueryData(['cart', 'count'], { items_count: 0, goods_total_uzs: 0 });

    act(() => result.current.set(1));
    act(() => result.current.set(2));
    act(() => result.current.set(3));
    expect(result.current.qty).toBe(3); // optimistic, nothing sent yet
    expect(client.getQueryData(['cart', 'count'])).toMatchObject({ items_count: 3 });
    expect(writes()).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUICK_DEBOUNCE_MS + 50);
    });
    expect(writes()).toEqual([{ method: 'POST', url: '/api/cart/items', body: { product_id: 'p1', qty: 3 } }]);
    expect(result.current.qty).toBe(3);
    expect(notices).toEqual([]);

    // «−» down to 0 removes the line
    act(() => result.current.set(0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUICK_DEBOUNCE_MS + 50);
    });
    expect(writes().at(-1)).toMatchObject({ method: 'DELETE', url: '/api/cart/items/p1' });
    expect(result.current.qty).toBe(0);
  });

  it('less in stock than asked: the server value wins and "Осталось N" is shown', async () => {
    server.available = 2;
    const { wrapper } = setup();
    const notices: QuickNotice[] = [];
    const { result } = renderHook(() => useQuickCart('p1', (n) => notices.push(n)), { wrapper });
    await vi.waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.set(4));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUICK_DEBOUNCE_MS + 50);
    });
    expect(result.current.qty).toBe(2);
    expect(result.current.max).toBe(2);
    expect(notices).toEqual([{ kind: 'left', n: 2 }]);
  });

  it('refused by the server: rolled back with a short message', async () => {
    server.fail = { status: 409, code: 'OUT_OF_STOCK' };
    const { wrapper } = setup();
    const notices: QuickNotice[] = [];
    const { result } = renderHook(() => useQuickCart('p1', (n) => notices.push(n)), { wrapper });
    await vi.waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.set(1));
    expect(result.current.qty).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUICK_DEBOUNCE_MS + 50);
    });
    expect(result.current.qty).toBe(0);
    expect(notices).toEqual([{ kind: 'error', code: 'OUT_OF_STOCK' }]);
  });
});

describe('QuickAdd on a card', () => {
  it('«В корзину» -> «− 1 +», same number on two cards, a click never opens the card; sold out is grey', async () => {
    const { wrapper } = setup();
    const opened = vi.fn();
    render(
      <a href="/product/p1" onClick={opened}>
        <QuickAdd productId="p1" inStock />
        <QuickAdd productId="p1" inStock />
      </a>,
      { wrapper },
    );
    const add = await screen.findAllByRole('button', { name: /В корзину/ });
    fireEvent.click(add[0]);
    expect(opened).not.toHaveBeenCalled();
    expect(screen.getAllByText('1')).toHaveLength(2); // both cards show the control
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('Добавлено в корзину'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Больше' })[1]);
    expect(screen.getAllByText('2')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Меньше' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Меньше' })[0]);
    expect(screen.getAllByRole('button', { name: /В корзину/ })).toHaveLength(2);
    expect(opened).not.toHaveBeenCalled();

    cleanup();
    render(<QuickAdd productId="p2" inStock={false} />, { wrapper });
    const out = await screen.findByRole('button', { name: 'Нет в наличии' });
    expect(out).toHaveProperty('disabled', true);
  });
});
