import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BundleForm, hiddenText, marginText, type BundleCheck } from './pages/Bundles';

const ok: BundleCheck = { list_total_uzs: 250_000, sale_total_uzs: 225_000, cost_total_uzs: 125_000, margin_pct: 44.4, too_low: false, hidden_because: [], no_cost: [] };
const low: BundleCheck = { ...ok, cost_total_uzs: 180_000, margin_pct: 20, too_low: true };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(check: BundleCheck) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(check), { headers: { 'content-type': 'application/json' } }));
  const bundle = {
    id: 'b1',
    slug: 'immunitet',
    title_ru: 'Иммунитет зимой',
    title_uz: null,
    goal: 'immunity',
    discount_pct: 10,
    is_active: true,
    sort_order: 0,
    doctor_text_ru: 'D3 и цинк',
    doctor_text_uz: null,
    items: [
      { product_id: 'p1', qty: 1, sku: 'OZN-A003', name_ru: 'D3 5000', status: 'active' },
      { product_id: 'p2', qty: 1, sku: 'OZN-A010', name_ru: 'Цинк', status: 'active' },
    ],
    check,
  };
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <BundleForm bundle={bundle} onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

describe('4.3 «Сеты от врача» в админке', () => {
  it('цена без скидки и со скидкой, маржа; сохранить можно', () => {
    show(ok);
    expect(screen.getByText('Маржа после скидки')).toBeTruthy();
    expect(screen.getByText('44,4%')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Выключить' })).toBeTruthy();
  });

  it('маржа ниже 30% — объяснение и кнопка «Сохранить» недоступна', () => {
    show(low);
    expect(screen.getByText(/Маржа ниже 30%/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('тексты маржи и причины скрытия', () => {
    expect(marginText({ ...ok, margin_pct: null })).toBe('нет себестоимости');
    expect(hiddenText(ok)).toBeNull();
    expect(hiddenText({ ...ok, hidden_because: [{ product_id: 'p2', sku: 'OZN-A010', reason: 'out_of_stock' }] })).toBe('Скрыт в Mini App: OZN-A010 — нет в наличии');
  });
});
