import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SheetsProvider } from './components/Sheets';
import { ToastProvider } from './components/Toast';
import { I18nProvider } from './lib/i18n';
import { resetQuickCart } from './lib/quick-cart';
import type { BankTransfer, Lang, ProductListItem } from './lib/types';
import { UpsellStrip } from './screens/Cart';
import { Payment } from './screens/Payment';
import { OnlineSoon } from './components/OrderItems';

// Telegram is reached only through the adapter
const tg = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock('./lib/telegram', async (orig) => {
  const real = await orig<typeof import('./lib/telegram')>();
  return { ...real, telegram: () => ({ openTelegramLink: (u: string) => tg.opened.push(u), BackButton: undefined }) };
});

const product = (id: string, price: number): ProductListItem =>
  ({ id, sku: id, name_ru: `Товар ${id}`, name_uz: `Mahsulot ${id}`, short_name_ru: null, short_name_uz: null, brand: 'VitaMeal', price_uzs: price, old_price_uzs: null, image_url: null, in_stock: true }) as ProductListItem;
const CITY = { region_id: 'r1', city_id: 'c1' };

let routes: Record<string, (init: RequestInit) => unknown>;
let posted: { url: string; body: unknown }[];
beforeEach(() => {
  vi.stubGlobal('scrollTo', () => undefined);
  tg.opened = [];
  posted = [];
  routes = {};
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (init.method && init.method !== 'GET') posted.push({ url, body: init.body ? JSON.parse(init.body as string) : null });
    const hit = Object.keys(routes).find((k) => url.includes(k));
    return new Response(JSON.stringify(hit ? routes[hit](init) : []));
  });
});
afterEach(() => {
  resetQuickCart();
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function show(lang: Lang, ui: ReactNode, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <ToastProvider>
            <SheetsProvider>
              <Routes>
                <Route path="*" element={ui} />
              </Routes>
            </SheetsProvider>
          </ToastProvider>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('3.5 upsell: an added card leaves the strip, the next product takes its place', () => {
  beforeEach(() => {
    routes['/cart/upsell'] = () => ({ items: [product('a', 100_000), product('b', 110_000), product('c', 90_000)], spare: [product('d', 120_000)], source: 'auto', remaining_uzs: 100_000 });
    routes['/cart/items'] = () => ({ items: [{ product_id: 'a', qty: 1, available_qty: 5, status: 'available' }], items_count: 1, goods_total_uzs: 300_000, discount_total_uzs: 0, warnings: [], can_checkout: true, delivery: null });
    routes['/cart/count'] = () => ({ items_count: 1, goods_total_uzs: 200_000 });
  });

  it('[+] adds one piece, the strip never shows a stepper, the spare product appears at once', async () => {
    const { container } = show('uz', <UpsellStrip city={CITY} goodsTotal={200_000} inCart={[]} />);
    expect(await screen.findByText('Mahsulot a')).toBeTruthy();
    expect(screen.queryByText('Mahsulot d')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'Savatga' })[0]);
    expect(screen.queryByText('Mahsulot a')).toBeNull();
    expect(screen.getByText('Mahsulot d')).toBeTruthy();
    expect(container.querySelector('.upsell .qty-control')).toBeNull();
    await waitFor(() => expect(posted.find((p) => p.url.includes('/cart/items'))?.body).toEqual({ product_id: 'a', qty: 1 }));
  });

  it('products already in the cart are not offered', async () => {
    show('ru', <UpsellStrip city={CITY} goodsTotal={200_000} inCart={['b']} />);
    expect(await screen.findByText('Товар a')).toBeTruthy();
    expect(screen.queryByText('Товар b')).toBeNull();
    expect(screen.getByText('Товар d')).toBeTruthy();
  });
});

describe('3.5 card transfer on one screen', () => {
  const base: BankTransfer = {
    method: 'card_transfer', order_number: 'V-1001', status: 'awaiting_payment', payment_status: 'payment_pending', amount_uzs: 120_000, purpose: '',
    requisites: null, card: { card_number: '8600000000000000' }, hint: { ru: 'Переведите', uz: 'O‘tkazing' }, pay_until: null,
    customer_reported_paid_at: null, receipt: { bot_url: 'https://t.me/vitalo_store_bot?start=rc_1', last: null },
  } as BankTransfer;

  it('shows the three steps at once; one tap marks «оплатил(а)» and opens the bot (UZ)', async () => {
    routes['/payment/bank-transfer/paid'] = () => ({ ok: true });
    routes['/payment/bank-transfer'] = () => base;
    show('uz', <Payment />, '/orders/o1/pay');
    expect(await screen.findByText('Karta raqamidan nusxa oling')).toBeTruthy();
    expect(screen.getByText(/o‘tkazing$/)).toBeTruthy();
    expect(screen.getByText('Chek skrinshotini yuboring')).toBeTruthy();
    expect(screen.getByText('8600 0000 0000 0000')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'To‘ladim — chekni yuborish' }));
    expect(tg.opened).toEqual(['https://t.me/vitalo_store_bot?start=rc_1']);
    await waitFor(() => expect(posted.some((p) => p.url.includes('/bank-transfer/paid'))).toBe(true));
    // the same screen: no «Что дальше» page, the receipt can be sent again
    expect(await screen.findByRole('button', { name: 'Chekni qayta yuborish' })).toBeTruthy();
    expect(screen.getByText('Karta raqamidan nusxa oling')).toBeTruthy();
  });

  it('after «оплатил(а)» the button only reopens the bot, «оплатил» is not sent twice (RU)', async () => {
    routes['/payment/bank-transfer'] = () => ({ ...base, customer_reported_paid_at: '2026-11-01T10:00:00Z' });
    show('ru', <Payment />, '/orders/o1/pay');
    expect(await screen.findByText('Спасибо! Ожидаем подтверждения оплаты менеджером')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Отправить чек ещё раз' }));
    expect(tg.opened).toEqual(['https://t.me/vitalo_store_bot?start=rc_1']);
    expect(posted).toEqual([]);
  });

  it('without the bot link the button is the plain «Я оплатил(а)»', async () => {
    routes['/payment/bank-transfer/paid'] = () => ({ ok: true });
    routes['/payment/bank-transfer'] = () => ({ ...base, receipt: { bot_url: null, last: null } });
    show('ru', <Payment />, '/orders/o1/pay');
    fireEvent.click(await screen.findByRole('button', { name: 'Я оплатил(а)' }));
    await waitFor(() => expect(posted.some((p) => p.url.includes('/bank-transfer/paid'))).toBe(true));
    expect(tg.opened).toEqual([]);
  });
});

describe('3.5 Payme / Click / Uzum «Скоро подключим»', () => {
  it('the label comes before the logos (RU / UZ)', () => {
    const { container } = show('uz', <OnlineSoon systems={['payme', 'click', 'uzum']} />);
    const block = container.querySelector('.online-soon')!;
    expect(block.firstElementChild!.textContent).toBe('Tez orada ulanadi');
    cleanup();
    show('ru', <OnlineSoon systems={['payme']} />);
    expect(screen.getByText('Скоро подключим')).toBeTruthy();
  });
});
