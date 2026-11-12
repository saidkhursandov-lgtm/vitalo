import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from './lib/auth';

vi.mock('./pages/Funnel', () => ({ FunnelCard: () => null }));
import { DashboardView, type DashboardData } from './pages/Dashboard';

afterEach(cleanup);

const day = (d: string, v: number, y: number, money = true) => ({
  day: d,
  vitalo_orders: v ? 1 : 0,
  yandex_orders: y ? 1 : 0,
  ...(money && { vitalo_revenue_uzs: v, yandex_revenue_uzs: y }),
});

const data = (over: Partial<DashboardData> = {}): DashboardData => ({
  days: 7,
  from: '2026-11-02',
  to: '2026-11-08',
  sales: {
    orders: 3,
    units: 4,
    revenue_uzs: 600_000,
    average_check_uzs: 200_000,
    channels: { vitalo: { orders: 2, revenue_uzs: 400_000 }, yandex: { orders: 1, revenue_uzs: 200_000 } },
    by_day: ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'].map((d, i) => day(d, i === 2 ? 400_000 : 0, i === 5 ? 200_000 : 0)),
  },
  margin: { gross_uzs: 240_000, percent: 40, revenue_with_cost_uzs: 600_000, revenue_without_cost_uzs: 0 },
  orders_created: { vitalo: 5, yandex: 2 },
  statuses: { delivered: 2 },
  top_products: [{ product_id: 'p1', sku: 'VTL-1', name_ru: 'Омега', qty: 3, revenue_uzs: 300_000 }],
  low_stock: [{ id: 'p2', sku: 'VTL-2', name_ru: 'Цинк', min_stock: 5, available: 1, incoming: 10 }],
  attention: { awaiting_confirmation: 2, units_attention: 0, yandex_to_ship: 1, ai_red: 0, compat_pending: 0, expiring_units: 0, waitlist: { products: 1, people: 4, in_stock: 0 } },
  ai_spend: { month_usd: 9, budget_usd: 10 },
  mini_app: { created: 10, cancelled: 4, paid: 5 },
  previous: { orders: 2, revenue_uzs: 400_000 },
  ...over,
});

const show = (d: DashboardData, perms: Permission[]) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <DashboardView data={d} can={(p) => perms.includes(p)} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('dashboard (генплан, этап 2)', () => {
  it('admin: revenue with the channel split and ± to the previous period, margin, Mini App cancels and payments, chart, «уже едет»', () => {
    const { container } = show(data(), ['orders.view', 'yandex.orders.view', 'inventory.view']);
    expect(screen.getByText('600 000 сум')).toBeTruthy();
    expect(screen.getByText('Mini App 400 000 сум · Яндекс 200 000 сум; +50 % к прошлому периоду')).toBeTruthy();
    expect(screen.getByText('Mini App 2 · Яндекс 1; +50 % к прошлому периоду')).toBeTruthy();
    expect(screen.getByText('Валовая маржа').closest('.kpi')!.textContent).toContain('40 %');
    // аудит 2.13 (D-64): no AI spend in the top row; cancels and payments of Mini App instead
    expect(screen.queryByText(/Расход VITALO AI/)).toBeNull();
    expect(screen.getByText('Доля отмен Mini App').closest('.kpi')!.textContent).toContain('40 %');
    expect(screen.getByText('Доля отмен Mini App').closest('.kpi')!.classList.contains('kpi-warn')).toBe(true);
    expect(screen.getByText('Конверсия заказ → оплата').closest('.kpi')!.textContent).toContain('50 %');
    expect(screen.getByRole('img', { name: 'Выручка по дням по каналам' })).toBeTruthy();
    expect(container.querySelectorAll('.bar-vitalo')).toHaveLength(1);
    expect(container.querySelectorAll('.bar-yandex')).toHaveLength(1);
    expect(screen.getByText('10')).toBeTruthy(); // incoming
  });

  it('«Требует внимания» lists only what is not zero, as links for those who may open them', () => {
    show(data(), ['orders.view']);
    expect(screen.getByRole('link', { name: /ждут подтверждения/ }).getAttribute('href')).toBe('/orders?awaiting_confirmation=true');
    expect(screen.getByText(/заказов Яндекса отгрузить/).closest('a')).toBeNull(); // no yandex.orders.view
    expect(screen.queryByText(/красных ответов/)).toBeNull();
    expect(screen.queryByText(/листа ожидания/)).toBeNull(); // nobody's product is in stock
  });

  it('marketer: no money — orders per day, no margin, no AI spend', () => {
    const d = data({
      sales: { orders: 3, units: 4, channels: { vitalo: { orders: 2 }, yandex: { orders: 1 } }, by_day: data().sales.by_day.map(({ day: dd, vitalo_orders, yandex_orders }) => ({ day: dd, vitalo_orders, yandex_orders })) },
      margin: undefined,
      ai_spend: undefined,
      top_products: [{ product_id: 'p1', sku: 'VTL-1', name_ru: 'Омега', qty: 3 }],
    });
    show(d, []);
    expect(screen.queryByText('Выручка')).toBeNull();
    expect(screen.queryByText('Валовая маржа')).toBeNull();
    expect(screen.getByRole('img', { name: 'Доставленные заказы по дням по каналам' })).toBeTruthy();
    expect(screen.queryByText(/сум/)).toBeNull();
  });
});
