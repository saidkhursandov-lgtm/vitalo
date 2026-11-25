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

const CHECKOUT = 'https://my.click.uz/services/pay/?service_id=1&merchant_id=2&amount=255000.00&transaction_param=202611030007';
let order: Order;
let starts: { url: string; lang: string }[];
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
    payment: { method: 'click', status: 'payment_pending', amount_uzs: 255_000, customer_reported_paid_at: null },
    history: [],
  } as unknown as Order;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.includes('/payments/online/')) {
      starts.push({ url, lang: JSON.parse(init.body as string).lang });
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

function show(lang: Lang, path = '/orders/o1/click') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <Routes>
            <Route path="/orders/:id/click" element={<PaymePayment provider="click" />} />
            <Route path="/orders/:id/payme" element={<PaymePayment />} />
            <Route path="/orders/:id" element={<p>order screen</p>} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Click payment screen', () => {
  it('«Оплатить через Click» asks the Click link and opens it through the Telegram adapter', async () => {
    show('ru');
    const button = await screen.findByRole('button', { name: /Оплатить через Click/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(starts).toEqual([{ url: expect.stringContaining('/payments/online/click/orders/o1/start'), lang: 'ru' }]);
    fireEvent.click(button);
    expect(tg.opened).toEqual([CHECKOUT]);
    expect(await screen.findByText(/Ждём подтверждения от Click/)).toBeTruthy();
  });

  it('Uzbek: «Click orqali to‘lash»', async () => {
    show('uz');
    expect(await screen.findByRole('button', { name: /Click orqali to‘lash/ })).toBeTruthy();
  });

  it('a product without ИКПУ: the Click message, the button stays off', async () => {
    startError = { code: 'CLICK_RECEIPT_INCOMPLETE' };
    show('ru');
    expect(await screen.findByText(/оплата через Click недоступна/)).toBeTruthy();
  });

  it('a Click order opened on the Payme screen goes to the order; «Оплатить» leads to the Click screen', async () => {
    show('ru', '/orders/o1/payme');
    expect(await screen.findByText('order screen')).toBeTruthy();
    expect(starts).toEqual([]);
    expect(payPath('o1', 'click')).toBe('/orders/o1/click');
  });
});
