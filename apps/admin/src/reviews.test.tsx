import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupsFor } from './lib/nav';
import { Reviews } from './pages/Reviews';

const perms = ['reviews.moderate'];
vi.mock('./lib/auth', async (orig) => ({
  ...(await orig<typeof import('./lib/auth')>()),
  useSession: () => ({ staff: { id: 's', name: 'Специалист', role: 'specialist' }, permissions: perms, can: (p: string) => perms.includes(p), logout: async () => undefined }),
}));

const plain = (s: string | null | undefined) => (s ?? '').replace(/[  ]/g, ' ');

const row = {
  id: 'r1',
  status: 'pending',
  rating: 5,
  tags: ['effect'],
  text: 'Вылечил гастрит за неделю!',
  author: 'Саидкомол Х.',
  show_name: true,
  lang: 'ru',
  medical_hint: true,
  media: [],
  product: { id: 'p1', sku: 'VTL-001', name: 'Магний B6' },
  order: { id: 'o1', number: 'VTL-20261110-0001', delivered_at: '2026-11-10T10:00:00Z' },
  customer: { id: 'u1', name: 'Саидкомол Хурсандов' },
  bonus_uzs: 3000,
  reject_reason: null,
  reject_note: null,
  moderated_by: null,
  moderated_at: null,
  reply: null,
  created_at: '2026-11-13T10:00:00Z',
};

const calls: { url: string; method: string; body: unknown }[] = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes('/staff/reviews?')) return new Response(JSON.stringify({ counts: { pending: 1 }, total: 1, items: [row] }));
    return new Response(JSON.stringify({ id: 'r1', status: 'rejected' }), { status: 201 });
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
        <Reviews />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('3.10-Б «Отзывы» in the admin', () => {
  it('the menu: whoever has reviews.moderate (admin, specialist)', () => {
    expect(groupsFor(['reviews.moderate']).flatMap((g) => g.items.map((i) => i.label))).toContain('Отзывы');
    expect(groupsFor(['orders.view']).flatMap((g) => g.items.map((i) => i.label))).not.toContain('Отзывы');
  });

  it('a pending review: the medical hint, the bonus on the button; «Отклонить» with the reason «medical» chosen', async () => {
    show();
    const card = await screen.findByRole('region', { name: 'Отзыв на Магний B6' });
    expect(within(card).getByText(/Похоже на обещание лечения/)).toBeTruthy();
    expect(plain(within(card).getByRole('button', { name: /Опубликовать и начислить/ }).textContent)).toContain('3 000');
    // no orders.view / customers.view: the number and the name without links
    expect(within(card).queryByRole('link', { name: 'VTL-20261110-0001' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Отклонить' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByRole('combobox') as HTMLSelectElement).value).toBe('medical');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отклонить' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/staff/reviews/r1/reject') && c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/reject'))?.body).toEqual({ reason: 'medical' });
  });
});
