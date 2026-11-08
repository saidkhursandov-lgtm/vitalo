import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Competitors, CostBars } from './components/Competitors';

const values = { brand: 'Test Brand', match_form: 'бисглицинат', dose_amount: 200, dose_unit: 'mg', dose_per: 'capsule', pack_count: 90 };
const ours = { id: 'p1', ...values };
const row = (over: object) => ({
  id: 'c1',
  platform: 'uzum',
  seller: 'Shop A',
  title: null,
  url: null,
  price_uzs: 185_000,
  observed_on: '2026-11-08',
  source: 'manual',
  ...values,
  match_status: 'match',
  mismatch_reasons: [],
  ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('«Цены конкурентов» (D-57, узел 4)', () => {
  it('shows «1-в-1» and «не тот товар» with the reason; the form starts with our values and sends them', async () => {
    let sent: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          sent = JSON.parse(String(init.body));
          return new Response(JSON.stringify(row({ id: 'c3' })), { status: 201 });
        }
        return new Response(JSON.stringify({ product: ours, items: [row({}), row({ id: 'c2', platform: 'pharmacy', seller: null, match_status: 'mismatch', mismatch_reasons: ['в банке: 90 / 60'] })] }), { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Competitors productId="p1" />
      </QueryClientProvider>,
    );
    await screen.findByText('1-в-1');
    expect(screen.getByText('не тот товар')).toBeTruthy();
    expect(screen.getByText('в банке: 90 / 60')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Добавить цену' }));
    expect((screen.getByLabelText('Бренд') as HTMLInputElement).value).toBe('Test Brand');
    expect((screen.getByLabelText('В банке, шт.') as HTMLInputElement).value).toBe('90');
    fireEvent.change(screen.getByLabelText('Цена, сум'), { target: { value: '179 000' } });
    fireEvent.change(screen.getByLabelText('В банке, шт.'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить цену' }));
    await waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toMatchObject({ platform: 'uzum', price_uzs: 179_000, brand: 'Test Brand', dose_amount: 200, dose_unit: 'mg', pack_count: 60 });
  });

  it('bars: purchase, our price, margin and each platform', () => {
    render(<CostBars d={{ cost_uzs: 120_000, price_uzs: 200_000, competitors: [{ platform: 'uzum', seller: null, price_uzs: 185_000, observed_on: '2026-11-08' }] }} />);
    expect(screen.getByText('Закупка')).toBeTruthy();
    expect(screen.getByText('Маржа')).toBeTruthy();
    expect(screen.getByText('Uzum Market')).toBeTruthy();
    expect(screen.getByText(/80\s000/)).toBeTruthy();
  });
});
