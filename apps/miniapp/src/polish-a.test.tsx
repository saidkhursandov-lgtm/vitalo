import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from './lib/i18n';
import type { Order } from './lib/types';
import { OrderDetail } from './screens/Orders';
import { Payment } from './screens/Payment';
import { PaymePayment } from './screens/PaymePayment';

/**
 * 6а-А (D-62): «Уведомления → Заказы» → an order «Ждёт оплаты» paid online (Payme) opened «Что-то пошло не так»:
 * the notification led to the card-transfer screen `/orders/:id/pay`, and the server answered NOT_BANK_TRANSFER.
 */
let order: Order;

function makeOrder(method: string, status: Order['status'] = 'awaiting_payment'): Order {
  return {
    id: 'o1',
    order_number: 'VTL-20261109-0002',
    status,
    payment_status: 'payment_pending',
    created_at: new Date().toISOString(),
    reserved_until: new Date(Date.now() + 1800_000).toISOString(),
    recipient: { name: 'Test', phone: '+998901234567' },
    delivery: { region: { name_ru: 'Ташкент', name_uz: 'Toshkent' }, city: { name_ru: 'Юнусабад', name_uz: 'Yunusobod' }, address_text: 'ул. 1', cost_uzs: 0 },
    customer_comment: null,
    items: [],
    totals: { goods_total_uzs: 255_000, discount_total_uzs: 0, delivery_cost_uzs: 0, total_uzs: 255_000 },
    payment: { method, status: 'payment_pending', amount_uzs: 255_000, customer_reported_paid_at: null },
    can_cancel: true,
    history: [{ from_status: null, to_status: status, reason: null, created_at: new Date().toISOString() }],
  } as unknown as Order;
}

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => undefined);
  order = makeOrder('payme');
  vi.stubGlobal('fetch', async (url: string) => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.includes('/orders/o1/payment/bank-transfer')) {
      return order.payment?.method === 'card_transfer'
        ? json({ method: 'card_transfer', order_number: order.order_number, amount_uzs: 255_000, card: { number: '8600123412341234' }, reserved_until: order.reserved_until })
        : json({ code: 'NOT_BANK_TRANSFER', message: 'Order is not paid by a manual transfer' }, 409);
    }
    if (url.includes('/payments/online/payme/orders/o1/start')) return json({ payment_id: 'p1', checkout_url: 'https://test.paycom.uz/x', pay_until: order.reserved_until });
    if (url.endsWith('/orders/o1')) return json(order);
    if (url.includes('/catalog/texts')) return json({ support_url: 'https://t.me/VITALO_support' });
    return json([]);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <I18nProvider lang="ru" setLang={() => undefined}>
          <Routes>
            <Route path="/orders/:id" element={<OrderDetail />} />
            <Route path="/orders/:id/pay" element={<Payment />} />
            <Route path="/orders/:id/payme" element={<PaymePayment />} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('6а-А: an order «Ждёт оплаты» from the notifications', () => {
  it('a Payme order opens its screen with «Оплатить» leading to Payme, not an error', async () => {
    show('/orders/o1');
    expect(await screen.findByRole('heading', { name: /0002/ })).toBeTruthy();
    expect(screen.queryByText('Что-то пошло не так')).toBeNull();
    const pay = screen.getByRole('link', { name: /Оплатить/ });
    expect(pay.getAttribute('href')).toBe('/orders/o1/payme');
  });

  it('an old «Оплатить» link to the transfer screen sends a Payme order to the order screen', async () => {
    show('/orders/o1/pay');
    expect(await screen.findByRole('heading', { name: /0002/ })).toBeTruthy();
    expect(screen.queryByText('Что-то пошло не так')).toBeNull();
    expect(screen.getByRole('link', { name: /Оплатить/ }).getAttribute('href')).toBe('/orders/o1/payme');
  });

  it('a card-transfer order on the Payme link goes to the order screen, whose «Оплатить» opens the transfer', async () => {
    order = makeOrder('card_transfer');
    show('/orders/o1/payme');
    expect(await screen.findByRole('heading', { name: /0002/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Оплатить/ }).getAttribute('href')).toBe('/orders/o1/pay');
  });

  it.each(['new', 'awaiting_payment', 'paid', 'picking', 'handed_to_delivery', 'in_transit', 'delivered', 'cancelled', 'return'] as Order['status'][])(
    'status %s: the order screen opens without an error',
    async (status) => {
      order = makeOrder('payme', status);
      show('/orders/o1');
      expect(await screen.findByRole('heading', { name: /0002/ })).toBeTruthy();
      expect(screen.queryByText('Что-то пошло не так')).toBeNull();
    },
  );
});
