import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SheetsProvider } from './components/Sheets';
import { ToastProvider } from './components/Toast';
import { I18nProvider } from './lib/i18n';
import { resetQuickCart } from './lib/quick-cart';
import type { Lang, ProductListItem } from './lib/types';
import { UpsellStrip } from './screens/Cart';

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
