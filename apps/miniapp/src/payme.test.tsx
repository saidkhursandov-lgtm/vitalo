import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from './lib/i18n';
import { payPath } from './lib/shop';
import type { Lang, Order } from './lib/types';
import { PaymePayment } from './screens/PaymePayment';

// Telegram is reached only through the adapter: openLink is recorded here
const tg = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock('./lib/telegram', async (orig) => {
  const real = await orig<typeof import('./lib/telegram')>();
  return { ...real, openLink: (u: string) => tg.opened.push(u) };
});

const CHECKOUT = 'https://checkout.test.paycom.uz/bT0xMjM7YWMub3JkZXJfaWQ9VlRMLTE7YT0xMDA7bD1ydQ==';
let order: Order;
let starts: { lang: string }[];
let startError: { code: string } | null;

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => undefined);
  tg.opened = [];
  starts = [];
  startError = null;
  order = {
    id: 'o1',
    order_number: 'VTL-20261103-0007',
    status: 'awaiting_payment',
    payment_status: 'payment_pending',
    reserved_until: new Date(Date.now() + 1800_000).toISOString(),
    totals: { total_uzs: 255_000 },
    payment: { method: 'payme', status: 'payment_pending', amount_uzs: 255_000, customer_reported_paid_at: null },
    history: [],
  } as unknown as Order;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.includes('/payments/online/payme/orders/o1/start')) {
      starts.push(JSON.parse(init.body as string));
      return startError ? json({ ...startError, message: 'x' }, 409) : json({ payment_id: 'p1', checkout_url: CHECKOUT, pay_until: order.reserved_until });
    }
    if (url.endsWith('/orders/o1')) return json(order);
    if (url.includes('/catalog/texts')) return json({ support_url: 'https://t.me/VITALO_support' });
    return json([]);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(lang: Lang) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/orders/o1/payme']}>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <Routes>
            <Route path="/orders/:id/payme" element={<PaymePayment />} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Payme payment screen', () => {
  it('«Оплатить через Payme» opens the Payme page through the Telegram adapter; then it waits for the confirmation', async () => {
    show('ru');
    const button = await screen.findByRole('button', { name: /Оплатить через Payme/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(starts).toEqual([{ lang: 'ru' }]);
    fireEvent.click(button);
    expect(tg.opened).toEqual([CHECKOUT]);
    expect(await screen.findByText(/Ждём подтверждения от Payme/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Открыть Payme ещё раз/ })).toBeTruthy();
  });

  it('Uzbek: the link is asked in Uzbek and the button fits «Payme orqali to‘lash»', async () => {
    show('uz');
    expect(await screen.findByRole('button', { name: /Payme orqali to‘lash/ })).toBeTruthy();
    await waitFor(() => expect(starts).toEqual([{ lang: 'uz' }]));
  });

  it('paid: «Оплата подтверждена», no Payme button, no new link', async () => {
    order = { ...order, status: 'paid', payment_status: 'payment_success' };
    show('ru');
    expect(await screen.findByText('Оплата подтверждена')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Payme/ })).toBeNull();
    expect(starts).toEqual([]);
  });

  it('the server refuses the link (a product without ИКПУ): a clear message, the button stays off', async () => {
    startError = { code: 'PAYME_RECEIPT_INCOMPLETE' };
    show('ru');
    expect(await screen.findByText(/оплата через Payme недоступна/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Оплатить через Payme/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('«Оплатить» goes to the Payme screen for Payme orders and to the transfer screen otherwise', () => {
    expect(payPath('o1', 'payme')).toBe('/orders/o1/payme');
    expect(payPath('o1', 'card_transfer')).toBe('/orders/o1/pay');
    expect(payPath('o1', null)).toBe('/orders/o1/pay');
  });
});
