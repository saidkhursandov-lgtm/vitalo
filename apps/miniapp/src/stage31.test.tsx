import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SheetsProvider } from './components/Sheets';
import { ToastProvider } from './components/Toast';
import { I18nProvider } from './lib/i18n';
import { matchesPlace, rankPlaces, toLatin } from './lib/place-search';
import { resetQuickCart } from './lib/quick-cart';
import type { BankTransfer, Lang, ProductListItem } from './lib/types';
import { UpsellStrip } from './screens/Cart';
import { Payment } from './screens/Payment';

// Telegram is reached only through the adapter
const tg = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock('./lib/telegram', async (orig) => {
  const real = await orig<typeof import('./lib/telegram')>();
  return { ...real, telegram: () => ({ openTelegramLink: (u: string) => tg.opened.push(u), BackButton: undefined }) };
});

const chilanzar = { name_ru: 'Чиланзарский район', name_uz: 'Chilonzor tumani' };
const shayx = { name_ru: 'Шайхантахурский район', name_uz: 'Shayxontohur tumani' };

describe('3.1 region / district search', () => {
  it('finds a district by part of the Russian or Uzbek name, any case', () => {
    for (const q of ['чилан', 'ЧИЛАН', 'Chilon', 'chilonzor', 'chilanzar', 'Чилонзор', '  чилан  ']) expect(matchesPlace(q, chilanzar)).toBe(true);
    expect(matchesPlace('юнус', chilanzar)).toBe(false);
  });

  it('understands Uzbek x/h and apostrophes', () => {
    expect(matchesPlace('шайхан', shayx)).toBe(true);
    expect(matchesPlace('shayhon', shayx)).toBe(true);
    expect(matchesPlace("Farg'ona", { name_ru: 'Ферганская область', name_uz: 'Fargʻona viloyati' })).toBe(true);
    expect(toLatin('Чиланзар')).toBe('chilanzar');
  });

  it('puts names that start with the query first', () => {
    const items = [{ name_ru: 'Мирзо-Улугбекский район', name_uz: null }, { name_ru: 'Улугбек', name_uz: null }];
    expect(rankPlaces(items, 'улуг', (x) => x.name_ru, 'ru').map((x) => x.name_ru)).toEqual(['Улугбек', 'Мирзо-Улугбекский район']);
  });
});

const product = (id: string, price: number): ProductListItem =>
  ({ id, sku: id, name_ru: `Товар ${id}`, name_uz: `Mahsulot ${id}`, short_name_ru: null, short_name_uz: null, brand: 'VitaMeal', price_uzs: price, old_price_uzs: null, image_url: null, in_stock: true }) as ProductListItem;
const CITY = { region_id: 'r1', city_id: 'c1' };

let upsellItems: ProductListItem[];
let transfer: BankTransfer;
let events: { event: string; props?: Record<string, unknown> }[];
beforeEach(() => {
  vi.stubGlobal('scrollTo', () => undefined);
  tg.opened = [];
  events = [];
  upsellItems = [product('a', 100_000), product('b', 110_000)];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const json = (b: unknown) => new Response(JSON.stringify(b));
    if (url.includes('/analytics/events')) {
      events.push(JSON.parse(init.body as string));
      return json({ accepted: true });
    }
    if (url.includes('/cart/upsell')) return json({ items: upsellItems, source: upsellItems.length ? 'auto' : null, remaining_uzs: 100_000 });
    if (url.includes('/cart/items')) {
      const id = JSON.parse(init.body as string).product_id;
      return json({ items: [{ product_id: id, qty: 1, available_qty: 5 }], items_count: 1, goods_total_uzs: 300_000, discount_total_uzs: 0, warnings: [], can_checkout: true, delivery: null });
    }
    if (url.endsWith('/cart/count')) return json({ items_count: 1, goods_total_uzs: 200_000 });
    if (url.includes('/payment/bank-transfer')) return json(transfer);
    if (url.includes('/catalog/texts')) return json({ support_url: 'https://t.me/VITALO_support' });
    return json([]);
  });
});
afterEach(() => {
  resetQuickCart();
  cleanup();
  vi.unstubAllGlobals();
});

function show(lang: Lang, ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <ToastProvider>
            <SheetsProvider>
              <Routes>
                <Route path="/" element={ui} />
              </Routes>
            </SheetsProvider>
          </ToastProvider>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('3.1 upsell under the free-delivery bar', () => {
  it('shows the products with [+], reports upsell_shown once and upsell_add on a tap', async () => {
    show('ru', <UpsellStrip city={CITY} goodsTotal={200_000} inCart={[]} />);
    expect(await screen.findByText('Добавьте к заказу')).toBeTruthy();
    expect(screen.getByText('Товар a')).toBeTruthy();
    expect(screen.getByText('Товар b')).toBeTruthy();
    await waitFor(() => expect(events.filter((e) => e.event === 'upsell_shown')).toEqual([{ event: 'upsell_shown', props: { count: 2, source: 'auto' } }]));

    fireEvent.click(screen.getAllByRole('button', { name: 'В корзину' })[0]);
    await waitFor(() => expect(events.some((e) => e.event === 'upsell_add' && e.props?.product_id === 'a')).toBe(true));
  });

  it('nothing at all when the server offers fewer than 2 products or no district is chosen', async () => {
    upsellItems = [];
    const { container } = show('uz', <UpsellStrip city={CITY} goodsTotal={200_000} inCart={[]} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector('.upsell')).toBeNull();
    cleanup();
    upsellItems = [product('a', 100_000), product('b', 110_000)];
    const none = show('uz', <UpsellStrip city={null} goodsTotal={200_000} inCart={[]} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(none.container.querySelector('.upsell')).toBeNull();
    expect(events).toEqual([]);
  });
});

describe('3.1 receipt in the bot from the payment screen', () => {
  const base: BankTransfer = {
    method: 'card_transfer', order_number: 'V-1001', status: 'awaiting_payment', payment_status: 'payment_pending', amount_uzs: 120_000, purpose: '',
    requisites: null, card: { card_number: '8600000000000000' }, hint: { ru: 'Переведите', uz: 'O‘tkazing' }, pay_until: null,
    customer_reported_paid_at: '2026-10-31T10:00:00Z', receipt: { bot_url: 'https://t.me/vitalo_store_bot?start=rc_1', last: null },
  } as BankTransfer;

  it('after «Я оплатил(а)» the button opens the bot with this order (UZ text in one piece)', async () => {
    transfer = base;
    show('uz', <Payment />);
    fireEvent.click(await screen.findByRole('button', { name: 'Chekni qayta yuborish' }));
    expect(tg.opened).toEqual(['https://t.me/vitalo_store_bot?start=rc_1']);
  });

  it('a sent receipt says «проверяем»; a rejected one shows the reason in the customer’s language', async () => {
    transfer = { ...base, receipt: { bot_url: base.receipt!.bot_url, last: { status: 'pending', reject_reason: null, created_at: '2026-10-31T10:05:00Z' } } };
    show('ru', <Payment />);
    expect(await screen.findByText('Чек получен — проверяем.')).toBeTruthy();
    cleanup();

    transfer = { ...base, customer_reported_paid_at: null, receipt: { bot_url: base.receipt!.bot_url, last: { status: 'rejected', reject_reason: 'Сумма не совпадает', created_at: '2026-10-31T10:05:00Z' } } };
    show('ru', <Payment />);
    expect((await screen.findByRole('alert')).textContent).toContain('Чек не принят: Сумма не совпадает');
  });
});
