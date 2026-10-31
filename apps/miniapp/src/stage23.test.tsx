import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickAdd } from './components/QuickAdd';
import { ToastProvider } from './components/Toast';
import { ProductTile } from './components/ui';
import { pricePerDay, tileLine } from './lib/format';
import { I18nProvider } from './lib/i18n';
import { resetQuickCart } from './lib/quick-cart';
import type { Lang, ProductCard } from './lib/types';
import { Product } from './screens/Product';

const PRODUCT: ProductCard = {
  id: 'p1', sku: 'OZN-A022', name_ru: 'Магний В6 200 таблеток Blueline Миофарм от стресса', name_uz: null,
  short_name_ru: 'Магний Цитрат + B6, 200 таб.', short_name_uz: 'Magniy Sitrat + B6, 200 tab.',
  substance_form_ru: 'Цитрат магния + Витамин B6', substance_form_uz: 'Magniy sitrat + Vitamin B6', course_days: 50,
  brand: 'MioPharm', brand_slug: 'miopharm', brand_name_ru: 'MioPharm', brand_name_uz: null,
  brand_why_ru: 'Фармацевтический подход к базовым нутрицевтикам.', brand_why_uz: 'Farmatsevtik yondashuv.',
  price_uzs: 98000, old_price_uzs: null, image_url: null, in_stock: true, available_qty: 1,
  std_bioavailability: true, std_tested: true, std_original: true, halal_vege: 'unknown',
  shell_ru: 'без капсулы', shell_uz: 'kapsulasiz', market_advantage_percent: 15,
  doctor_verdict_ru: 'Органический цитрат магния.', doctor_verdict_uz: 'Organik magniy sitrat.',
  manufacturer: 'ООО Миофарм', country: 'Россия', form: 'Таблетки',
  short_description_ru: 'Текст с упаковки.', short_description_uz: null, composition_ru: 'Цитрат магния', composition_uz: null,
  nutrition_ru: null, nutrition_uz: null, directions_ru: null, directions_uz: null, warnings_ru: null, warnings_uz: null,
  media: [], categories: [], similar: [], also_bought: [],
};

let qty: number;
let writes: string[];
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  qty = 0;
  writes = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const json = (b: unknown) => new Response(JSON.stringify(b));
    if (method !== 'GET' && url.includes('/cart/items')) {
      writes.push(method);
      qty = Math.min(method === 'DELETE' ? 0 : JSON.parse(init.body as string).qty + (method === 'POST' ? qty : 0), 1);
    }
    if (url.endsWith('/cart/count')) return json({ items_count: qty, goods_total_uzs: 98000 * qty });
    if (url.includes('/catalog/products/p1')) return json(PRODUCT);
    if (url.includes('/catalog/texts'))
      return json({ support_url: 'https://t.me/VITALO_support', product_disclaimer: { ru: 'БАД', uz: 'BAD' }, delivery_terms: { tashkent: null, regions: null }, delivery_days_label: null });
    if (url.includes('/cart')) {
      const items = qty
        ? [{ product_id: 'p1', sku: 'A', name_ru: 'М', name_uz: 'M', brand: 'X', image_url: null, status: 'available', qty, available_qty: 1, unit_price_uzs: 98000, line_total_uzs: 98000 * qty }]
        : [];
      return json({ items, warnings: [], goods_total_uzs: 98000 * qty, discount_total_uzs: 0, items_count: qty, can_checkout: qty > 0, delivery: null });
    }
    return json([]);
  });
});
afterEach(() => {
  resetQuickCart();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function show(lang: Lang, ui: React.ReactNode, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <ToastProvider>
            <Routes>
              <Route path="/" element={ui} />
              <Route path="/product/:id" element={ui} />
            </Routes>
          </ToastProvider>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('2.3 fixes: helpers', () => {
  it('price per day is rounded down to tens', () => {
    expect(pricePerDay(98000, 30)).toBe(3260);
    expect(pricePerDay(125000, 50)).toBe(2500);
    expect(pricePerDay(76000, 60)).toBe(1260);
  });

  it('2.4 patch: the mini-card line is days and price per day (rounded down to tens); none without days or under 7', () => {
    expect(tileLine(98000, 30)).toEqual({ days: 30, perDay: 3260 });
    expect(tileLine(125000, 45)).toEqual({ days: 45, perDay: 2770 });
    expect(tileLine(98000, null)).toBeNull();
    expect(tileLine(98000, 6)).toBeNull();
  });
});

describe('2.3 fixes: mini-card', () => {
  it('fixed places: name, one meta line (kept even when empty), price, then the button row', () => {
    const { container } = show('ru', <ProductTile product={{ ...PRODUCT, substance_form_ru: null, course_days: null }} />);
    const body = container.querySelector('.tile-body')!;
    expect([...body.children].map((e) => e.className)).toEqual(['tile-brand', 'tile-name', 'tile-meta', 'tile-foot']);
    expect(container.querySelector('.tile-foot')!.children[0].className).toBe('tile-price');
    expect(container.querySelector('.tile-action .quick-round')).not.toBeNull();
  });

  it('at the maximum «+» stays tappable and says «Максимум в наличии» instead of adding; no extra line under the card', async () => {
    show('ru', <QuickAdd productId="p1" inStock />);
    fireEvent.click(await screen.findByRole('button', { name: 'В корзину' }));
    const more = await screen.findByRole('button', { name: 'Больше' });
    await vi.advanceTimersByTimeAsync(600);
    expect(more.getAttribute('aria-disabled')).toBe('true');
    const before = writes.length;
    fireEvent.click(more);
    await vi.advanceTimersByTimeAsync(600);
    expect(writes.length).toBe(before);
    expect(screen.getByText('Максимум в наличии').closest('.qty-control')).toBeNull();
  });
});

describe('2.3 fixes: product card', () => {
  it('order: standard grid → verdict → specialist widget → brand card → «О товаре» → «Описание» folded first', async () => {
    const { container } = show('ru', <Product />, '/product/p1');
    await screen.findByText('Органический цитрат магния.');
    const order = [...container.querySelectorAll('.std-grid, .verdict, .ask-card, .why-brand, section.card, details.card')].map(
      (e) => e.className.split(' ')[0] + (e.tagName === 'DETAILS' ? `:${e.querySelector('summary')!.textContent}` : ''),
    );
    expect(order.slice(0, 6)).toEqual(['std-grid', 'verdict', 'ask-card', 'why-brand', 'card', 'card:Описание']);
    expect(container.querySelector('details.card')!.hasAttribute('open')).toBe(false);
    expect(order).toContain('card:Состав');

    expect(screen.getByText('Сомневаетесь, подойдёт ли вам препарат?')).toBeTruthy();
    expect(screen.getByText('Спросить специалиста VITALO об этом товаре')).toBeTruthy();
    expect(screen.getByText('Отбор и контроль VITALO')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Почему MioPharm отобран в VITALO' })).toBeTruthy();
    // «О товаре»: brand, maker, country, form — the full name is gone (it stays for search)
    expect(screen.queryByText('Полное название')).toBeNull();
    expect(screen.queryByText(PRODUCT.name_ru)).toBeNull();
    for (const label of ['Бренд', 'Производитель', 'Страна', 'Форма выпуска']) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText('Хватит на 50 дней • 1 960 сум/день')).toBeTruthy();
  });

  it('no brand text — no brand card; the buy panel: «В корзину» and «Купить сейчас» as two buttons, the price once', async () => {
    PRODUCT.brand_why_ru = null;
    PRODUCT.brand_why_uz = null;
    const { container } = show('uz', <Product />, '/product/p1');
    await screen.findByText('Organik magniy sitrat.');
    expect(container.querySelector('.why-brand')).toBeNull();
    const panel = container.querySelector('.buy-panel')!;
    expect([...panel.querySelectorAll('.buy-panel-main button')].map((b) => b.textContent)).toEqual(['Savatga', 'Hozir sotib olish']);
    expect(panel.querySelectorAll('.price-now')).toHaveLength(1);
    expect(screen.getByText('Bu preparat sizga mos kelishiga ikkilanyapsizmi?')).toBeTruthy();
  });
});
