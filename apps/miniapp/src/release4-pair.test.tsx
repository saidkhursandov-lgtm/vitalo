import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerfectPair } from './components/PerfectPair';
import { ToastProvider } from './components/Toast';
import { I18nProvider } from './lib/i18n';
import type { Lang, ProductListItem } from './lib/types';

const C: ProductListItem = {
  id: 'c1', sku: 'OZN-A028', name_ru: 'Swanson Vitamin C 1000 мг', name_uz: null, short_name_ru: 'Vitamin C 1000 мг + шиповник', short_name_uz: null,
  brand: 'Swanson', price_uzs: 203000, old_price_uzs: null, image_url: null, in_stock: true,
} as ProductListItem;

beforeEach(() => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify([])));
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

describe('4.1 «Идеальная пара» в карточке товара', () => {
  it('название, цена, «почему вместе» и кнопка в корзину; ссылка ведёт на товар пары', () => {
    show('ru', <PerfectPair pair={{ product: C, why_ru: 'Витамин C участвует в синтезе коллагена.', why_uz: 'C vitamini kollagen sinteziga yordam beradi.' }} />);
    expect(screen.getByRole('heading', { name: 'Идеальная пара' })).toBeTruthy();
    expect(screen.getByText('Vitamin C 1000 мг + шиповник')).toBeTruthy();
    expect(screen.getByText(/203\s000/)).toBeTruthy();
    expect(screen.getByText('Витамин C участвует в синтезе коллагена.')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/product/c1');
    expect(screen.getByRole('button', { name: /В корзину/ })).toBeTruthy();
  });

  it('по-узбекски — узбекский текст; без текста правила строки нет; без пары блока нет', () => {
    const { container, rerender } = show('uz', <PerfectPair pair={{ product: C, why_ru: 'RU', why_uz: 'C vitamini kollagen uchun' }} />);
    expect(screen.getByRole('heading', { name: 'Mukammal juftlik' })).toBeTruthy();
    expect(screen.getByText('C vitamini kollagen uchun')).toBeTruthy();
    rerender(<></>);
    cleanup();
    show('ru', <PerfectPair pair={{ product: C, why_ru: null, why_uz: null }} />);
    expect(document.querySelector('.pair-why')).toBeNull();
    cleanup();
    const empty = show('ru', <PerfectPair pair={null} />);
    expect(empty.container.innerHTML).toBe('');
    expect(container).toBeTruthy();
  });
});
