import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupsFor } from './lib/nav';
import { CrossBorder } from './pages/CrossBorder';

let perms: string[] = [];
vi.mock('./lib/auth', async (orig) => ({
  ...(await orig<typeof import('./lib/auth')>()),
  useSession: () => ({ staff: { id: 's', name: 'А', role: 'manager' }, permissions: perms, can: (p: string) => perms.includes(p), logout: async () => undefined }),
}));

const IHERB = { id: 's-iherb', name: 'iHerb', kind: 'foreign' };
const GHN = { id: 's-ghn', name: 'Glorious Healthy Nutrition', kind: 'local' };
const waiting = [
  { item_id: 'i1', order_id: 'o1', order_number: '091126-001', paid_at: '2026-11-09T05:00:00Z', cod: false, supplier: IHERB, expected_to: '2026-11-23', product_id: 'p1', sku: 'VTL-H001', name_ru: 'Омега-3', iherb_url: 'https://uz.iherb.com/pr/x/1', qty: 2 },
  { item_id: 'i2', order_id: 'o2', order_number: '091126-002', paid_at: '2026-11-09T06:00:00Z', cod: false, supplier: IHERB, expected_to: '2026-11-01', product_id: 'p2', sku: 'VTL-GH002', name_ru: 'Магний', iherb_url: null, qty: 1 },
  { item_id: 'i3', order_id: 'o3', order_number: '091126-003', paid_at: null, cod: true, supplier: GHN, expected_to: '2026-11-11', product_id: 'p3', sku: 'VTL-GH003', name_ru: 'Цинк', iherb_url: null, qty: 1 },
];
let posted: { url: string; body: unknown }[];

beforeEach(() => {
  posted = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(init.body as string) });
        return json({ id: 'b1', number: 1 }, 201);
      }
      if (url.includes('/cross-border/waiting')) return json(waiting);
      if (url.includes('/cross-border/batches')) return json([]);
      if (url.includes('/staff/purchases')) return json({ items: [], total: 0, total_pages: 0 });
      return json([]);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <CrossBorder />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('«Поставки под заказ» (D-60/D-61)', () => {
  it('the menu item for manager and warehouse, in «Закупки и склад»', () => {
    const g = groupsFor(['cross_border.view']);
    expect(g.map((x) => x.label)).toEqual(['Закупки и склад']);
    expect(g[0].items.map((i) => i.label)).toEqual(['Поставки под заказ']);
  });

  it('the manager ticks the lines ordered from one supplier and creates a delivery; the overdue line is marked; suppliers are not mixed', async () => {
    perms = ['cross_border.view', 'cross_border.manage'];
    show();
    expect(await screen.findByText('Омега-3')).toBeTruthy();
    expect(screen.getByText('открыть на iHerb')).toBeTruthy();
    expect(screen.getByText('Магний').closest('tr')?.className).toContain('row-warn');
    expect(screen.getByText('Цинк').closest('tr')?.textContent).toContain('При получении');
    const create = screen.getByRole('button', { name: 'Создать поставку (0)' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Отметить VTL-H001'));
    fireEvent.click(screen.getByLabelText('Отметить VTL-GH003'));
    expect(screen.getByText(/в одной поставке — один поставщик/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Создать поставку (2)' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Отметить VTL-GH003'));
    fireEvent.click(screen.getByRole('button', { name: 'Создать поставку (1)' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ url: expect.stringContaining('/staff/cross-border/batches'), body: { item_ids: ['i1'] } });
  });

  it('the warehouse only looks: no checkboxes, no buttons', async () => {
    perms = ['cross_border.view'];
    show();
    expect(await screen.findByText('Омега-3')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('Отдать со склада')).toBeNull();
  });
});
