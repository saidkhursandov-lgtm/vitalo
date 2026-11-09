import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from './components/Toast';
import { ProductTile } from './components/ui';
import { countryName } from './lib/format';
import { I18nProvider } from './lib/i18n';
import type { Lang, ProductListItem } from './lib/types';

/** 6а-В (D-62): the manual promo label on the tile; the country in Uzbek. */
const product = (extra: Partial<ProductListItem> = {}): ProductListItem =>
  ({ id: 'p1', sku: 'A1', name_ru: 'Магний B6', name_uz: 'Magniy B6', short_name_ru: null, short_name_uz: null, brand: 'VitaMeal', price_uzs: 100_000, old_price_uzs: null, image_url: null, in_stock: true, course_days: 30, campaign: null, promo_label: null, ...extra }) as ProductListItem;

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => undefined);
  vi.stubGlobal('fetch', async () => new Response('[]'));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(lang: Lang, ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <ToastProvider>{ui}</ToastProvider>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('6а-В: promo label on the tile', () => {
  it.each([
    ['hit', 'ru', 'Хит'],
    ['new', 'ru', 'Новинка'],
    ['new', 'uz', 'Yangi'],
    ['eleven_eleven', 'ru', '11.11'],
    ['black_friday', 'uz', 'Black Friday'],
  ] as const)('%s (%s) → «%s» on the photo', (label, lang, text) => {
    const { container } = show(lang, <ProductTile product={product({ promo_label: label })} />);
    const badge = container.querySelector('.tile-badges .promo-label')!;
    expect(badge.textContent).toBe(text);
    expect(badge.classList.contains(`promo-${label}`)).toBe(true);
  });

  it('no label — no badge; a running sale shows its own badge instead of the label', () => {
    expect(show('ru', <ProductTile product={product()} />).container.querySelector('.promo-label')).toBeNull();
    cleanup();
    const sale = { id: 'c1', slug: 's', skin: 'black_friday' as const, title_ru: 'BF', title_uz: null, discount_pct: 30, list_price_uzs: 100_000, ends_at: null };
    const { container } = show('ru', <ProductTile product={product({ promo_label: 'hit', price_uzs: 70_000, campaign: sale })} />);
    expect(container.querySelector('.promo-label')).toBeNull();
    expect(container.querySelector('.tile-badges .sale-badge')).not.toBeNull();
  });
});

describe('6а-В: country in Uzbek', () => {
  it('«США» → «AQSh» in Uzbek, Russian stays; an unknown country stays as it is', () => {
    expect(countryName('США', 'uz')).toBe('AQSh');
    expect(countryName('Россия', 'uz')).toBe('Rossiya');
    expect(countryName('США', 'ru')).toBe('США');
    expect(countryName('Тувалу', 'uz')).toBe('Тувалу');
  });
});
