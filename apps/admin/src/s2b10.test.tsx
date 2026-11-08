import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let perms: string[] = ['units.view', 'units.start_tracking'];
vi.mock('./lib/auth', async (orig) => ({
  ...(await orig<typeof import('./lib/auth')>()),
  useSession: () => ({ staff: { id: 's', name: 'А', role: 'admin' }, permissions: perms, can: (p: string) => perms.includes(p), logout: async () => undefined }),
}));
import { Reconcile } from './pages/Receiving';

const row = (over: object) => ({
  product_id: 'p1',
  sku: 'OZN-A019',
  name_ru: 'Цинк',
  unit_tracking: false,
  units_in_stock: 3,
  units_reserved_yandex: 0,
  units_reserved_vitalo: 0,
  actual_qty: 3,
  reserved_vitalo: 0,
  difference: 0,
  sold_by_orders: 0,
  explained: false,
  state: 'not_tracked',
  ...over,
});

let posted: string[];
beforeEach(() => {
  posted = [];
  perms = ['units.view', 'units.start_tracking'];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (items: object[]) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push(url);
        return new Response(JSON.stringify({ sku: 'OZN-A019', unit_tracking: true, changed: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ hint: 'h', items }), { status: 200 });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Reconcile />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe('«Сверка»: товар с банками без учёта по банкам (S2B-10)', () => {
  it('admin: stock = units → «Включить учёт по банкам» calls the API', async () => {
    show([row({})]);
    fireEvent.click(await screen.findByRole('button', { name: 'Включить учёт по банкам' }));
    await waitFor(() => expect(posted).toEqual(['/api/staff/units/start-tracking/p1']));
  });

  it('stock ≠ units → no button, says a recount is needed', async () => {
    show([row({ actual_qty: 7, units_in_stock: 2, difference: -5 })]);
    expect(await screen.findByText(/нужен начальный остаток/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Включить учёт по банкам' })).toBeNull();
  });

  it('not admin → no button, only a hint', async () => {
    perms = ['units.view'];
    show([row({})]);
    expect(await screen.findByText(/учёт включает администратор/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Включить учёт по банкам' })).toBeNull();
  });
});
