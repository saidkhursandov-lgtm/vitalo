import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupsFor } from './lib/nav';
import { Returns } from './pages/Returns';

const perms = ['returns.manage'];
vi.mock('./lib/auth', async (orig) => ({
  ...(await orig<typeof import('./lib/auth')>()),
  useSession: () => ({ staff: { id: 's', name: 'Менеджер', role: 'manager' }, permissions: perms, can: (p: string) => perms.includes(p), logout: async () => undefined }),
}));

const plain = (s: string | null | undefined) => (s ?? "").replace(/\s/gu, ' ');

const row = {
  id: 'r1',
  status: 'requested',
  reason: 'damaged',
  comment: 'Банка треснула',
  full_order: false,
  created_at: '2026-11-13T10:00:00Z',
  order: { id: 'o1', number: 'VTL-20261110-0001', delivered_at: '2026-11-10T10:00:00Z', total_uzs: 200_000, payment: 'card_transfer', recipient: 'Тест', phone: '+998901234567' },
  customer: { id: 'u1', name: 'Тест Витало' },
  items: [{ sku: 'VTL-001', name: 'Магний B6', qty: 1, line_qty: 2, amount_uzs: 100_000 }],
  suggested_uzs: 100_000,
  media: [],
  refund_amount_uzs: null,
  approved_by: null,
  approved_at: null,
  reject_reason: null,
  rejected_by: null,
  rejected_at: null,
  refund_method: null,
  refund_comment: null,
  refunded_by: null,
  refunded_at: null,
  bonus_reversed_uzs: 0,
  bonus_returned_uzs: 0,
};

const calls: { url: string; method: string; body: unknown }[] = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes('/staff/returns?')) return new Response(JSON.stringify({ counts: { requested: 1 }, total: 1, items: [row] }));
    return new Response(JSON.stringify({ id: 'r1', status: 'approved' }), { status: 201 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Returns />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('3.10-В «Возвраты» in the admin', () => {
  it('menu item only with returns.manage', () => {
    const items = (p: Parameters<typeof groupsFor>[0]) => groupsFor(p).flatMap((g) => g.items.map((i) => i.label));
    expect(items(['returns.manage'])).toContain('Возвраты');
    expect(items(['orders.view'])).not.toContain('Возвраты');
  });

  it('a request: reason, the jars, «Одобрить» with the suggested amount', async () => {
    show();
    expect(await screen.findByText('Товар повреждён')).toBeTruthy();
    expect(plain(screen.getByText(/1 из 2 шт/).textContent)).toContain('100 000');
    fireEvent.click(screen.getByRole('button', { name: 'Одобрить' }));
    const input = screen.getByLabelText(/Сумма к возврату/) as HTMLInputElement;
    expect(input.value).toBe('100000');
    fireEvent.change(input, { target: { value: '300000' } }); // more than the order
    expect((screen.getByRole('button', { name: /Одобрить на/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '90000' } });
    fireEvent.click(screen.getByRole('button', { name: /Одобрить на/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/staff/returns/r1/approve') && c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/approve'))!.body).toEqual({ amount_uzs: 90_000 });
  });

  it('«Отклонить» needs a reason', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Отклонить' }));
    const send = screen.getAllByRole('button', { name: 'Отклонить' }).at(-1) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Причина'), { target: { value: 'На фото банка целая' } });
    fireEvent.click(send);
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/reject'))?.body).toEqual({ reason: 'На фото банка целая' }));
  });
});
