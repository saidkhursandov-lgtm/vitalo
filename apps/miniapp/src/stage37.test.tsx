import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countdownText } from './components/Campaign';
import { HomeCarousel } from './components/HomeBlocks';
import { OrderTotals } from './components/OrderItems';
import { SheetsProvider } from './components/Sheets';
import { ToastProvider } from './components/Toast';
import { Price, ProductTile } from './components/ui';
import { I18nProvider, translate } from './lib/i18n';
import { resetQuickCart } from './lib/quick-cart';
import type { CampaignSkin, Cart, Lang, ProductListItem, ShopBanner } from './lib/types';
import { warningText } from './screens/Cart';
import { CampaignScreen } from './screens/Campaign';

vi.mock('./lib/telegram', async (orig) => {
  const real = await orig<typeof import('./lib/telegram')>();
  return { ...real, telegram: () => ({ BackButton: undefined }) };
});

/** money() puts non-breaking spaces between thousands. */
const plain = (s: string | null | undefined) => (s ?? '').replace(/[  ]/g, ' ');
const ENDS = '2026-11-12T19:00:00.000Z';
const sale = (skin: CampaignSkin, pct = 30) => ({ id: 'c1', slug: 'black-friday', skin, title_ru: 'Чёрная пятница', title_uz: 'Qora juma', discount_pct: pct, list_price_uzs: 100_000, ends_at: ENDS });
const product = (skin: CampaignSkin | null, extra: Partial<ProductListItem> = {}): ProductListItem =>
  ({ id: 'p1', sku: 'A1', name_ru: 'Магний B6', name_uz: 'Magniy B6', short_name_ru: null, short_name_uz: null, brand: 'VitaMeal', price_uzs: skin ? 70_000 : 100_000, old_price_uzs: skin ? 100_000 : null, image_url: null, in_stock: true, course_days: 30, campaign: skin ? sale(skin) : null, ...extra }) as ProductListItem;

let routes: Record<string, () => unknown>;
let posted: { url: string; body: { event?: string; props?: Record<string, unknown> } | null }[];
beforeEach(() => {
  vi.stubGlobal('scrollTo', () => undefined);
  posted = [];
  routes = {};
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (init.method && init.method !== 'GET') posted.push({ url, body: init.body ? JSON.parse(init.body as string) : null });
    const hit = Object.keys(routes).find((k) => url.includes(k));
    if (hit === '/catalog/campaigns/ended') return new Response(JSON.stringify({ code: 'CAMPAIGN_NOT_RUNNING' }), { status: 404 });
    return new Response(JSON.stringify(hit ? routes[hit]() : []));
  });
});
afterEach(() => {
  resetQuickCart();
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function show(lang: Lang, ui: ReactNode, path = '/', pattern = '*') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <ToastProvider>
            <SheetsProvider>
              <Routes>
                <Route path={pattern} element={ui} />
              </Routes>
            </SheetsProvider>
          </ToastProvider>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const events = (name: string) => posted.filter((p) => p.body?.event === name);

describe('3.7 sale skins on the card', () => {
  it('Black Friday: dark badge «−30% Black Friday», dark frame, old price crossed out over the new one', () => {
    const { container } = show('ru', <ProductTile product={product('black_friday')} />);
    const badge = container.querySelector('.tile-sale')!;
    expect(badge.className).toContain('sale-black_friday');
    expect(badge.textContent).toBe('−30%Black Friday');
    expect(container.querySelector('.tile')!.className).toContain('sale-card-black_friday');
    expect(plain(container.querySelector('.tile-price-old')?.textContent)).toBe('100 000 сум');
    expect(container.querySelector('.tile-price-old')!.tagName).toBe('S');
    expect(container.querySelector('.tile-price')!.className).toContain('sale-text-black_friday');
    expect(plain(container.querySelector('.tile-price')?.textContent)).toBe('70 000 сум');
    // the old Market-style «−30%» is not drawn next to the sale badge
    expect(container.querySelector('.tile-discount')).toBeNull();
  });

  it('11.11 — orange badge with dark text; «Акция» — «Chegirma» in Uzbek; «Без плашки» — only the prices', () => {
    const { container, unmount } = show('ru', <ProductTile product={product('eleven_eleven')} />);
    expect(container.querySelector('.tile-sale')!.textContent).toBe('−30%11.11');
    expect(container.querySelector('.tile-price')!.className).toContain('sale-text-eleven_eleven');
    unmount();
    const uz = show('uz', <ProductTile product={product('sale')} />);
    expect(uz.container.querySelector('.tile-sale')!.textContent).toBe('−30%Chegirma');
    uz.unmount();
    const none = show('ru', <ProductTile product={product('none')} />);
    expect(none.container.querySelector('.sale-badge')).toBeNull();
    expect(plain(none.container.querySelector('.tile-price-old')?.textContent)).toBe('100 000 сум');
  });

  it('«· Y сум/день» is counted from the sale price', () => {
    const { container } = show('ru', <ProductTile product={product('sale')} />);
    expect(plain(container.querySelector('.tile-meta')?.textContent)).toContain('2 330 сум/день'); // 70 000 / 30
  });

  it('product page price: two lines, not capped at 25% like a Market old price', () => {
    const { container } = show('ru', <Price price={65_000} old={100_000} size="lg" campaign={{ ...sale('black_friday', 35) }} />);
    expect(plain(container.querySelector('.sale-price-old')?.textContent)).toBe('100 000 сум');
    expect(plain(container.querySelector('.sale-price-now')?.textContent)).toBe('65 000 сум');
  });

  it('[+] on a sale card sends add_to_cart and campaign_add_to_cart', async () => {
    routes['/cart/items'] = () => ({ items: [{ product_id: 'p1', qty: 1, available_qty: 5, status: 'available' }], items_count: 1, goods_total_uzs: 70_000, discount_total_uzs: 0, warnings: [], can_checkout: true, delivery: null });
    show('ru', <ProductTile product={product('black_friday')} />);
    fireEvent.click(screen.getByRole('button', { name: 'В корзину' }));
    await waitFor(() => expect(events('campaign_add_to_cart')).toHaveLength(1));
    expect(events('campaign_add_to_cart')[0].body?.props).toEqual({ campaign_id: 'c1', product_id: 'p1' });
  });
});

describe('3.7 countdown and the home slide', () => {
  const t = (lang: Lang) => (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate(lang, k, p);

  it('«2 дн. 14:20» / «2 kun 14:20»; under a day — hours and minutes; after the end — nothing', () => {
    const now = new Date(ENDS).getTime() - ((2 * 24 + 14) * 60 + 20) * 60_000;
    expect(countdownText(ENDS, now, t('ru'))).toBe('2 дн. 14:20');
    expect(countdownText(ENDS, now, t('uz'))).toBe('2 kun 14:20');
    expect(countdownText(ENDS, new Date(ENDS).getTime() - 65 * 60_000, t('ru'))).toBe('01:05');
    expect(countdownText(ENDS, new Date(ENDS).getTime(), t('ru'))).toBeNull();
  });

  const banners: ShopBanner[] = [
    { id: 'campaign-c1', kind: 'campaign', image_url: null, image_jpeg_url: null, link: { type: 'campaign', value: 'black-friday' }, campaign: { id: 'c1', slug: 'black-friday', skin: 'black_friday', title_ru: 'Чёрная пятница', title_uz: 'Qora juma', ends_at: ENDS, max_discount_pct: 30, products_count: 12 } },
    { id: 'doctor', kind: 'doctor', image_url: null, image_jpeg_url: null, link: null },
  ];

  it('the sale slide comes first, with «До конца», and leads to the sale page; a tap is campaign_banner_click', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(new Date(ENDS).getTime() - ((2 * 24 + 14) * 60 + 20) * 60_000));
    const { container } = show('ru', <HomeCarousel firstOrderFree={false} freeFromUzs={null} banners={banners} />);
    const first = container.querySelector('.hero-track > *')!;
    expect(first.className).toContain('sale-slide-black_friday');
    expect(first.getAttribute('href')).toBe('/campaign/black-friday');
    expect(first.textContent).toContain('Чёрная пятница');
    expect(first.textContent).toContain('Скидки до 30%');
    expect(first.textContent).toContain('До конца: 2 дн. 14:20');
    fireEvent.click(first);
    await waitFor(() => expect(events('campaign_banner_click')).toHaveLength(1));
  });

  it('Uzbek slide: «Tugashiga», UZ title', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(new Date(ENDS).getTime() - 26 * 60 * 60_000));
    const { container } = show('uz', <HomeCarousel firstOrderFree={false} freeFromUzs={null} banners={banners} />);
    const first = container.querySelector('.hero-track > *')!;
    expect(first.textContent).toContain('Qora juma');
    expect(first.textContent).toContain('Tugashiga: 1 kun 02:00');
  });
});

describe('3.7 sale page', () => {
  it('shows the sale head and its products, sends campaign_view', async () => {
    routes['/catalog/campaigns/black-friday'] = () => ({ campaign: banners0(), items: [product('black_friday')] });
    show('ru', <CampaignScreen />, '/campaign/black-friday', '/campaign/:slug');
    expect(await screen.findByRole('heading', { name: 'Чёрная пятница' })).toBeTruthy();
    expect(screen.getByText('Все товары акции')).toBeTruthy();
    expect(screen.getByText('Магний B6')).toBeTruthy();
    await waitFor(() => expect(events('campaign_view')).toHaveLength(1));
  });

  it('an ended sale says so instead of an empty list', async () => {
    routes['/catalog/campaigns/ended'] = () => null;
    show('uz', <CampaignScreen />, '/campaign/ended', '/campaign/:slug');
    expect(await screen.findByText('Aksiya tugagan yoki hali boshlanmagan')).toBeTruthy();
  });
});

function banners0() {
  return { id: 'c1', slug: 'black-friday', skin: 'black_friday', title_ru: 'Чёрная пятница', title_uz: 'Qora juma', ends_at: ENDS, max_discount_pct: 30, products_count: 1 };
}

describe('3.7 totals, promo code and the ended sale', () => {
  it('«Акция «11.11»: −X сум» between the goods and the promo code; the hint about 15%', () => {
    const { container } = show(
      'ru',
      <OrderTotals goods={300_000} campaigns={[{ promotion_id: 'c1', title_ru: '11.11', title_uz: null, skin: 'eleven_eleven', amount_uzs: 60_000 }]} discount={10_000} promo={{ code: 'VITALO10', free_delivery: false }} delivery={0} total={230_000} saleHint />,
    );
    const rows = [...container.querySelectorAll('.sum-row')].map((r) => plain(r.textContent));
    expect(rows).toEqual(['Товары300 000 сум', 'Акция «11.11»−60 000 сум', 'Промокод VITALO10−10 000 сум', 'ДоставкаБесплатно', 'Итого230 000 сум']);
    expect(screen.getByText('Промокод не действует на товары акции со скидкой больше 15%')).toBeTruthy();
  });

  it('Uzbek: «11.11» aksiyasi', () => {
    show('uz', <OrderTotals goods={300_000} campaigns={[{ promotion_id: 'c1', title_ru: '11.11', title_uz: '11.11', skin: 'eleven_eleven', amount_uzs: 60_000 }]} delivery={null} total={240_000} />);
    expect(screen.getByText('«11.11» aksiyasi')).toBeTruthy();
  });

  it('«Акция завершилась» when the sale ended while the product was in the cart', () => {
    const cart = { items: [{ product_id: 'p1', name_ru: 'Магний B6', name_uz: 'Magniy B6' }] } as unknown as Cart;
    const w = { code: 'campaign_ended' as const, product_id: 'p1', old_price_uzs: 70_000, new_price_uzs: 100_000, campaign_title_ru: '11.11' };
    expect(plain(warningText(w, cart, 'ru', (k, p) => translate('ru', k, p)))).toBe('Акция завершилась: «Магний B6» теперь 100 000 сум (было 70 000 сум)');
    expect(plain(warningText(w, cart, 'uz', (k, p) => translate('uz', k, p)))).toBe('Aksiya tugadi: «Magniy B6» endi 100 000 so‘m (70 000 so‘m edi)');
  });
});
