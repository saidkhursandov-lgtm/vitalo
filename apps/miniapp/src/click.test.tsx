import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from './lib/i18n';
import { payPath } from './lib/shop';
import type { Lang, Order, PaymentChoices } from './lib/types';
import { PaymePayment } from './screens/PaymePayment';

// Telegram is reached only through the adapter: openPaymentLink is recorded here
const tg = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock('./lib/telegram', async (orig) => {
  const real = await orig<typeof import('./lib/telegram')>();
  return { ...real, openPaymentLink: (u: string) => tg.opened.push(u) };
});

const CLICK_URL = 'https://my.click.uz/services/pay/?service_id=1&merchant_id=2&amount=255000.00&transaction_param=202611030007';
const PAYME_URL = 'https://checkout.paycom.uz/abc';
let order: Order;
let starts: { url: string; lang: string }[];
let changes: string[];
let startError: { code: string } | null;
let choices: PaymentChoices;

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => undefined);
  tg.opened = [];
  starts = [];
  changes = [];
  startError = null;
  order = {
    id: 'o1',
    order_number: 'VTL-20261103-0007',
    status: 'awaiting_payment',
    payment_status: 'payment_pending',
    reserved_until: new Date(Date.now() + 1800_000).toISOString(),
    totals: { total_uzs: 255_000 },
    payment: { method: 'click', status: 'payment_pending', amount_uzs: 255_000, customer_reported_paid_at: null },
    history: [],
  } as unknown as Order;
  choices = {
    order_id: 'o1',
    current: 'click',
    total_uzs: 255_000,
    reserved_until: order.reserved_until,
    blocked: null,
    methods: [
      { code: 'payme', unavailable: null },
      { code: 'click', unavailable: null },
      { code: 'card_transfer', unavailable: null },
    ],
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.includes('/payments/online/orders/o1/methods')) return json(choices);
    if (url.includes('/payments/online/orders/o1/method')) {
      const method = JSON.parse(init.body as string).method;
      changes.push(method);
      order = { ...order, payment: { ...order.payment!, method } };
      choices = { ...choices, current: method };
      return json(choices);
    }
    if (url.includes('/start')) {
      starts.push({ url, lang: JSON.parse(init.body as string).lang });
      if (startError) return json({ ...startError, message: 'x' }, 409);
      return json({ payment_id: 'p1', checkout_url: url.includes('/payme/') ? PAYME_URL : CLICK_URL, pay_until: order.reserved_until });
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

function show(lang: Lang, path = '/orders/o1/payment') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <Routes>
            <Route path="/orders/:id/payment" element={<PaymePayment />} />
            <Route path="/orders/:id/click" element={<PaymePayment />} />
            <Route path="/orders/:id/payme" element={<PaymePayment />} />
            <Route path="/orders/:id/pay" element={<p>transfer screen</p>} />
            <Route path="/orders/:id" element={<p>order screen</p>} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('«Оплата заказа» with Click', () => {
  it('«Оплатить через Click» opens the prepared Click link through the Telegram adapter, then «Не открылось?»', async () => {
    show('ru');
    const button = await screen.findByRole('button', { name: /Оплатить через Click/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(starts).toEqual([{ url: expect.stringContaining('/payments/online/click/orders/o1/start'), lang: 'ru' }]);
    fireEvent.click(button);
    expect(tg.opened).toEqual([CLICK_URL]);
    expect(await screen.findByText(/Ждём подтверждения от Click/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Скопировать ссылку на оплату/ })).toBeTruthy();
  });

  it('Uzbek: «Click orqali to‘lash»', async () => {
    show('uz');
    expect(await screen.findByRole('button', { name: /Click orqali to‘lash/ })).toBeTruthy();
  });

  it('a product without ИКПУ: the Click message', async () => {
    startError = { code: 'CLICK_RECEIPT_INCOMPLETE' };
    show('ru');
    expect(await screen.findByText(/оплата через Click недоступна/)).toBeTruthy();
  });

  it('the old /payme link of a Click order shows Click; «Оплатить» leads to «Оплата заказа»', async () => {
    show('ru', '/orders/o1/payme');
    expect(await screen.findByRole('button', { name: /Оплатить через Click/ })).toBeTruthy();
    expect(payPath('o1', 'click')).toBe('/orders/o1/payment');
    expect(payPath('o1', 'uzum')).toBe('/orders/o1/payment');
  });
});

describe('«Оплата заказа»: another way to pay', () => {
  it('the amount, the deadline and the chosen way; Click → Payme: the Payme link is asked and opened', async () => {
    show('ru');
    expect(await screen.findByRole('heading', { name: 'Оплата заказа' })).toBeTruthy();
    expect(screen.getByText(/Оплатите до/)).toBeTruthy();
    expect(await screen.findByText('Способ оплаты')).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Click' }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: 'Payme' }));
    await waitFor(() => expect(changes).toEqual(['payme']));
    const button = await screen.findByRole('button', { name: /Оплатить через Payme/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(starts.map((s) => s.url)).toEqual([expect.stringContaining('/click/'), expect.stringContaining('/payme/')]);
    fireEvent.click(button);
    expect(tg.opened).toEqual([PAYME_URL]);
  });

  it('Click → card transfer: «Показать реквизиты для перевода» leads to the transfer screen', async () => {
    show('ru');
    fireEvent.click(await screen.findByRole('radio', { name: /Перевод на карту/ }));
    await waitFor(() => expect(changes).toEqual(['card_transfer']));
    fireEvent.click(await screen.findByRole('link', { name: /Показать реквизиты/ }));
    expect(await screen.findByText('transfer screen')).toBeTruthy();
  });

  it('only one way open: no list, just the button', async () => {
    choices = { ...choices, methods: [{ code: 'click', unavailable: null }] };
    show('ru');
    expect(await screen.findByRole('button', { name: /Оплатить через Click/ })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Способ оплаты')).toBeNull();
  });

  it('a refused change shows why, the order keeps its way', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.includes('/methods')) return json(choices);
      if (url.includes('/method')) return json({ code: 'PAYMENT_METHOD_UNAVAILABLE', message: 'x' }, 422);
      if (url.includes('/start')) return json({ payment_id: 'p1', checkout_url: CLICK_URL, pay_until: null });
      if (url.endsWith('/orders/o1')) return json(order);
      return json([]);
    });
    show('ru');
    fireEvent.click(await screen.findByRole('radio', { name: 'Payme' }));
    expect(await screen.findByText(/способ оплаты сейчас недоступен/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Оплатить через Click/ })).toBeTruthy();
  });
});
