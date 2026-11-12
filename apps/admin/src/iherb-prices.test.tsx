import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupsFor } from './lib/nav';
import { autoIdle, Chart, Iherb } from './pages/Iherb';

const preview = {
  format: 'table',
  problems: ['iHerb 555: нет цены в сумах'],
  summary: { total: 2, matched: 1, unknown: 1, will_change: 1, big_jumps: 1 },
  items: [
    {
      iherb_product_id: '62118',
      title: null,
      price_uzs: 100_000,
      list_price_uzs: null,
      in_stock: true,
      bestseller: false,
      weight_kg: null,
      product: { id: 'p1', sku: 'A', name_ru: 'Омега-3', price_uzs: 140_000, status: 'active' },
      last_price_uzs: 60_000,
      change_pct: 66.7,
      auto: { target_uzs: 180_000, apply: true, skip_reason: null, skip_label: null, floor_applied: false, big_jump: true },
    },
    { iherb_product_id: '777', title: 'Чужой', price_uzs: 55_000, list_price_uzs: null, in_stock: false, bestseller: false, weight_kg: null, product: null, last_price_uzs: null, change_pct: null, auto: null },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('«iHerb и цены» (D-57)', () => {
  it('аудит 4.7: auto pricing without any iHerb price is marked «не действует»', () => {
    expect(autoIdle({ auto_pricing_enabled: true, last_snapshot: null })).toBe(true);
    expect(autoIdle({ auto_pricing_enabled: false, last_snapshot: null })).toBe(false);
    expect(autoIdle({ auto_pricing_enabled: true, last_snapshot: { price_uzs: 1, in_stock: true, bestseller: false, bestseller_rank: null, taken_at: '2026-11-01' } })).toBe(false);
  });

  it('only the admin sees the menu item', () => {
    expect(groupsFor(['iherb.prices']).flatMap((g) => g.items.map((i) => i.label))).toEqual(['iHerb и цены']);
    expect(groupsFor(['purchases.view']).flatMap((g) => g.items.map((i) => i.label))).not.toContain('iHerb и цены');
  });

  it('check shows the preview (nothing saved), then «Сохранить» sends the same table', async () => {
    const posted: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posted.push(url);
          const body = init.body as FormData;
          expect(body.get('text')).toContain('62118');
          return new Response(JSON.stringify(url.includes('dry_run') ? preview : { ...preview, upload_id: 'u1' }), { status: 201 });
        }
        if (url.includes('/settings')) return new Response(JSON.stringify({ reminders: false }), { status: 200 });
        return new Response('[]', { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <Iherb />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByPlaceholderText(/uz\.iherb\.com/), { target: { value: '62118; 100 000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Проверить' }));
    await screen.findByText('Что получится');
    expect(posted).toEqual(['/api/staff/iherb/uploads?dry_run=1']);
    expect(screen.getByText(/изменилась на 30% и больше/)).toBeTruthy();
    expect(screen.getByText('больше 20%')).toBeTruthy();
    expect(screen.getByText(/сохранится в историю/)).toBeTruthy();
    expect(screen.getByText('Не прочитано: 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить и поменять 1 цен' }));
    await waitFor(() => expect(screen.getByText(/Срез сохранён/)).toBeTruthy());
    expect(posted[1]).toBe('/api/staff/iherb/uploads');
  });

  it('the chart draws the iHerb points, the VITALO steps and the cost line', () => {
    const now = Date.now();
    const iso = (daysAgo: number) => new Date(now - daysAgo * 86400_000).toISOString();
    const { container } = render(
      <Chart
        days={30}
        h={{
          product: { id: 'p1', sku: 'A', name_ru: 'Омега-3', price_uzs: 181_000, cost_uzs: 120_000, markup_percent: 80 },
          snapshots: [
            { taken_at: iso(10), price_uzs: 95_000, list_price_uzs: null, in_stock: true, bestseller: false },
            { taken_at: iso(5), price_uzs: 100_300, list_price_uzs: null, in_stock: false, bestseller: false },
          ],
          changes: [{ created_at: iso(5), old_price_uzs: 170_000, new_price_uzs: 181_000, iherb_price_uzs: 100_300, big_jump: false, floor_applied: false, yandex_check: true }],
        }}
      />,
    );
    expect(container.querySelectorAll('circle.dot-iherb')).toHaveLength(2);
    expect(container.querySelectorAll('circle.dot-empty')).toHaveLength(1);
    expect(container.querySelector('path.line-vitalo')).toBeTruthy();
    expect(container.querySelector('line.line-cost')).toBeTruthy();
  });
});
