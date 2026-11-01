import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrandStrip } from './components/CatalogLayers';
import { I18nProvider } from './lib/i18n';
import type { BrandCard, BrandPage, CategoryNode, Lang } from './lib/types';
import { BrandScreen, Catalog } from './screens/Catalog';

const cat = (slug: string, name_ru: string, name_uz: string, n: number): CategoryNode => ({ id: slug, slug, name_ru, name_uz, product_count: n, children: [] });
const BRANDS: BrandCard[] = [
  { id: 'b1', slug: 'now-foods', name: 'NOW Foods', name_uz: null, logo_url: '/uploads/brands/now.webp', product_count: 4 },
  { id: 'b2', slug: 'ostrovit', name: 'OstroVit', name_uz: null, logo_url: null, product_count: 2 },
];
const PAGE: BrandPage = { ...BRANDS[0], country_ru: 'США', country_uz: 'AQSH', why_vitalo_ru: 'Проверенный производитель с GMP.', why_vitalo_uz: 'GMP sertifikatli ishlab chiqaruvchi.' };

let calls: string[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.includes('/catalog/categories')) {
      return json({
        need: [cat('sleep', 'Сон и стресс', 'Uyqu va stress', 5), cat('energy', 'Энергия и мозг', 'Energiya va miya', 9)],
        product_type: [cat('vitamins', 'Витамины', 'Vitaminlar', 17), cat('creatine-amino', 'Креатин и аминокислоты', 'Kreatin va aminolar', 3)],
      });
    }
    if (url.includes('/catalog/brands/showcase')) return json(BRANDS);
    if (url.includes('/catalog/brands/now-foods')) return json(PAGE);
    if (url.includes('/catalog/brands/')) return json({ code: 'NOT_FOUND', message: 'Brand not found' }, 404);
    if (url.includes('/catalog/products')) return json({ items: [], page: 1, page_size: 24, total: 0, total_pages: 0 });
    return json([]);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(lang: Lang, ui: ReactNode, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <Routes>
            <Route path="/" element={ui} />
            <Route path="/brand/:slug" element={ui} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('catalog in three layers (2.2)', () => {
  it('needs, types and brands on one screen; one level — every card opens its product list', async () => {
    const { container } = show('ru', <Catalog />);
    expect(await screen.findByText('По потребности')).toBeTruthy();
    expect(screen.getByText('По типу')).toBeTruthy();
    expect(await screen.findByText('Проверенные бренды')).toBeTruthy();
    expect(screen.getByText('Энергия и мозг').closest('a')?.getAttribute('href')).toBe('/catalog/products?category=energy');
    expect(screen.getByText('Креатин и аминокислоты').closest('a')?.getAttribute('href')).toBe('/catalog/products?category=creatine-amino');
    // no more «По потребности | По типу продукта» switch and no nested lists
    expect(container.querySelector('.segmented')).toBeNull();
    expect(container.querySelectorAll('.cat-list').length).toBe(0);
  });

  it('Uzbek names', async () => {
    show('uz', <Catalog />);
    expect(await screen.findByText('Ehtiyoj bo‘yicha')).toBeTruthy();
    expect(screen.getByText('Turi bo‘yicha')).toBeTruthy();
    expect(screen.getByText('Kreatin va aminolar')).toBeTruthy();
    expect(await screen.findByText('Ishonchli brendlar')).toBeTruthy();
  });
});

describe('«Проверенные бренды» (2.2)', () => {
  it('logo or the first letter; a card opens the brand page', async () => {
    const { container } = show('ru', <BrandStrip />);
    const now = await screen.findByText('NOW Foods');
    expect(now.closest('a')?.getAttribute('href')).toBe('/brand/now-foods');
    expect(container.querySelector('.brand-card img')?.getAttribute('src')).toBe('/uploads/brands/now.webp');
    expect(screen.getByText('O')).toBeTruthy(); // OstroVit has no logo yet
  });

  it('nothing in stock — no block at all', async () => {
    vi.stubGlobal('fetch', async () => new Response('[]'));
    const { container } = show('ru', <BrandStrip />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toBe('');
  });
});

describe('brand page (2.2)', () => {
  it('logo, name, country, «Почему NOW Foods в VITALO» on top, then the brand products', async () => {
    show('ru', <BrandScreen />, '/brand/now-foods');
    expect(await screen.findByRole('heading', { name: 'NOW Foods' })).toBeTruthy();
    expect(screen.getByText('США')).toBeTruthy();
    expect(screen.getByText('Почему NOW Foods в VITALO')).toBeTruthy();
    expect(screen.getByText('Проверенный производитель с GMP.')).toBeTruthy();
    expect(screen.getByText('Товары бренда')).toBeTruthy();
    await screen.findByText('Ничего не найдено');
    expect(calls.some((u) => u.includes('/catalog/products') && u.includes('brand=NOW+Foods'))).toBe(true);
  });

  it('Uzbek: country and the text in Uzbek', async () => {
    show('uz', <BrandScreen />, '/brand/now-foods');
    expect(await screen.findByText('AQSH')).toBeTruthy();
    expect(screen.getByText('Nega NOW Foods VITALOda')).toBeTruthy();
    expect(screen.getByText('GMP sertifikatli ishlab chiqaruvchi.')).toBeTruthy();
  });

  it('unknown brand', async () => {
    show('ru', <BrandScreen />, '/brand/nope');
    expect(await screen.findByText('Бренд не найден')).toBeTruthy();
  });
});
