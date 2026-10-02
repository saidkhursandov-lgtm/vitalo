import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../lib/i18n';
import type { Cart, Lang } from '../lib/types';
import { CartWarnings, FreeShippingProgress } from './Cart';

const cart: Cart = {
  items: [
    { product_id: 'p1', sku: 'A', name_ru: 'Омега-3', name_uz: 'Omega-3', brand: 'X', image_url: null, status: 'available', qty: 2, available_qty: 2, unit_price_uzs: 90000, line_total_uzs: 180000 },
    { product_id: 'p2', sku: 'B', name_ru: 'Цинк', name_uz: 'Rux', brand: 'Y', image_url: null, status: 'unavailable', qty: 1, available_qty: 0, unit_price_uzs: 50000, line_total_uzs: 50000 },
  ],
  warnings: [
    { code: 'price_changed', product_id: 'p1', old_price_uzs: 100000, new_price_uzs: 90000 },
    { code: 'qty_reduced', product_id: 'p1', requested_qty: 5, available_qty: 2 },
    { code: 'out_of_stock', product_id: 'p2' },
  ],
  goods_total_uzs: 180000,
  discount_total_uzs: 0,
  items_count: 2,
  can_checkout: true,
  delivery: null,
};

afterEach(cleanup);

const wrap = (lang: Lang, ui: React.ReactNode) => render(<I18nProvider lang={lang} setLang={() => undefined}>{ui}</I18nProvider>);

describe('CartWarnings', () => {
  it('explains every price/stock change in Russian', () => {
    wrap('ru', <CartWarnings cart={cart} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('«Омега-3»: цена изменилась с 100 000 сум на 90 000 сум');
    expect(alert.textContent).toContain('«Омега-3»: доступно только 2 шт., количество уменьшено');
    expect(alert.textContent).toContain('«Цинк» закончился');
  });

  it('uses Uzbek product names in Uzbek', () => {
    wrap('uz', <CartWarnings cart={cart} />);
    expect(screen.getByRole('alert').textContent).toContain('«Rux» tugadi');
  });

  it('renders nothing without warnings', () => {
    const { container } = wrap('ru', <CartWarnings cart={{ ...cart, warnings: [] }} />);
    expect(container.textContent).toBe('');
  });
});

describe('FreeShippingProgress', () => {
  it('shows the API message and the progress towards the threshold', () => {
    wrap(
      'ru',
      <FreeShippingProgress
        quote={{ tariff_uzs: 20000, free_shipping_threshold_uzs: 300000, cost_uzs: 20000, is_free: false, remaining_for_free_uzs: 120000, message_ru: 'Добавьте ещё на 120 000 сум — доставка будет бесплатной', message_uz: 'uz' }}
      />,
    );
    expect(screen.getByText(/Добавьте ещё на 120 000 сум/)).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('60');
  });
});
