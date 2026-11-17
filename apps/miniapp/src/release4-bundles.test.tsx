import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderTotals } from './components/OrderItems';
import { ToastProvider } from './components/Toast';
import { I18nProvider } from './lib/i18n';
import type { Lang, ProductListItem, ShopBundle } from './lib/types';
import { BundleScreen } from './screens/Bundle';

const item = (id: string, name: string, price: number) =>
  ({ id, sku: id, name_ru: name, name_uz: null, short_name_ru: name, short_name_uz: null, brand: 'NOW', price_uzs: price, old_price_uzs: null, image_url: null, in_stock: true }) as ProductListItem;

const SET: ShopBundle = {
  id: 'b1',
  slug: 'immunitet',
  title_ru: 'Крепкий иммунитет',
  title_uz: 'Kuchli immunitet',
  goal: 'immunity',
  doctor_text_ru: 'D3 и цинк вместе поддерживают иммунитет.',
  doctor_text_uz: 'D3 va rux birga immunitetni qo‘llab-quvvatlaydi.',
  discount_pct: 10,
  list_total_uzs: 250_000,
  sale_total_uzs: 225_000,
  days: 60,
  items: [
    { qty: 1, product: item('p1', 'D3 5000 МЕ', 100_000) },
    { qty: 1, product: item('p2', 'Цинк 50 мг', 150_000) },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(lang: Lang, ui: ReactNode, path = '/set/immunitet') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <ToastProvider>
            <Routes>
              <Route path="/set/:slug" element={ui} />
              <Route path="*" element={ui} />
            </Routes>
          </ToastProvider>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('4.3 «Сеты от врача» в Mini App', () => {
  it('страница сета: товары, слово врача, «Хватит на», цена со скидкой; кнопка кладёт все банки', async () => {
    const posted: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).includes('/catalog/bundles/immunitet')) return new Response(JSON.stringify(SET));
      if (String(url).includes('/cart/items')) {
        posted.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ items: [], warnings: [], goods_total_uzs: 250_000, discount_total_uzs: 25_000, bundle_discount_uzs: 25_000, items_count: 2, can_checkout: true, delivery: null }));
      }
      return new Response(JSON.stringify({}));
    });
    show('ru', <BundleScreen />);
    expect(await screen.findByRole('heading', { name: 'Крепкий иммунитет' })).toBeTruthy();
    expect(screen.getByText('D3 5000 МЕ')).toBeTruthy();
    expect(screen.getByText('Цинк 50 мг')).toBeTruthy();
    expect(screen.getByText('D3 и цинк вместе поддерживают иммунитет.')).toBeTruthy();
    expect(screen.getByText('Хватит на 60 дн.')).toBeTruthy();
    expect(screen.getByText(/225\s000/)).toBeTruthy();
    expect(screen.getByText(/Экономия 25\s000/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Добавить сет в корзину' }));
    await waitFor(() => expect(posted).toEqual([{ product_id: 'p1', qty: 1 }, { product_id: 'p2', qty: 1 }]));
    expect(await screen.findByText('Сет в корзине')).toBeTruthy();
  });

  it('по-узбекски — узбекские тексты; недоступный сет — понятное сообщение', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(SET)));
    show('uz', <BundleScreen />);
    expect(await screen.findByRole('heading', { name: 'Kuchli immunitet' })).toBeTruthy();
    expect(screen.getByText('D3 va rux birga immunitetni qo‘llab-quvvatlaydi.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'To‘plamni savatga qo‘shish' })).toBeTruthy();
    cleanup();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'Set not found' }), { status: 404 }));
    show('ru', <BundleScreen />);
    expect(await screen.findByText('Этот сет сейчас недоступен')).toBeTruthy();
  });

  it('итоги: «Скидка сета» отдельной строкой, промокод — остальное', () => {
    show('ru', <OrderTotals goods={250_000} discount={29_000} bundle={25_000} promo={{ code: 'VITALO5', free_delivery: false }} delivery={0} total={221_000} />, '/');
    expect(screen.getByText('Скидка сета')).toBeTruthy();
    expect(screen.getByText(/−25\s000/)).toBeTruthy();
    expect(screen.getByText(/−4\s000/)).toBeTruthy();
  });
});
