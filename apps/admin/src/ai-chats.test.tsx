import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupsFor } from './lib/nav';
import { AiChats } from './pages/AiChats';

const row = {
  id: 'c1',
  number: 'AI-20261112-0001',
  created_at: '2026-11-12T10:00:00Z',
  lang: 'ru',
  topic: 'sleep',
  outcome: 'answered',
  questions: 2,
  empty_cart: false,
  cost_usd: 0.0042,
  model: 'claude-haiku-5-5',
  review: null,
  deleted: false,
  purged: false,
  user: { id: 'u1', name: 'Алишер', username: 'alisher' },
};
const detail = {
  ...row,
  updated_at: '2026-11-12T10:01:00Z',
  cart: [{ product_id: 'p1', sku: 'VTL-001', name: 'Магний B6' }],
  review_note: null,
  reviewed_by: null,
  reviewed_at: null,
  messages: [
    { id: 'm1', role: 'user', kind: 'question', text: 'Мне трудно заснуть', created_at: '2026-11-12T10:00:00Z', model: null, cost_usd: 0, latency_ms: null, error: null },
    {
      id: 'm2',
      role: 'ai',
      kind: 'answer',
      text: 'Для сна может помочь магний.',
      created_at: '2026-11-12T10:00:04Z',
      model: 'claude-haiku-5-5',
      cost_usd: 0.0042,
      latency_ms: 3800,
      error: null,
      products: [{ product_id: 'p1', name: 'Магний B6', fit: 'helps', level_text: 'Есть данные исследований', text: 'Может помочь при напряжении.', in_cart: true }],
      followups: ['Как принимать?'],
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('D-70: «Переписки VITALO AI»', () => {
  it('the menu: the admin and the specialist (compat.answer), not a manager (compat.view)', () => {
    expect(groupsFor(['compat.view', 'compat.answer']).flatMap((g) => g.items.map((i) => i.label))).toContain('Переписки VITALO AI');
    expect(groupsFor(['compat.view']).flatMap((g) => g.items.map((i) => i.label))).not.toContain('Переписки VITALO AI');
  });

  it('the month list with filters and search; the conversation opens with the cart and the model; «Ошибка» with a comment', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.includes('/staff/ai/chats/c1')) return new Response(JSON.stringify(init?.method === 'PATCH' ? { ok: true } : detail), { status: 200 });
        return new Response(JSON.stringify({ month: '2026-11', months: ['2026-11', '2026-10'], total: 1, cost_usd: 0.0042, items: [row] }), { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AiChats />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('button', { name: 'AI-20261112-0001' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'Сон' })).toBeTruthy();
    expect(screen.getByLabelText('Месяц')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Тема'), { target: { value: 'joints' } });
    await waitFor(() => expect(calls.at(-1)!.url).toContain('topic=joints'));
    fireEvent.change(screen.getByLabelText('Поиск'), { target: { value: 'AI-20261112' } });
    fireEvent.submit(screen.getByLabelText('Поиск'));
    await waitFor(() => expect(calls.at(-1)!.url).toContain('q=AI-20261112'));

    fireEvent.click(screen.getByRole('button', { name: 'AI-20261112-0001' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Для сна может помочь магний.')).toBeTruthy();
    expect(dialog.textContent).toContain('Магний B6 (VTL-001)');
    expect(dialog.textContent).toContain('claude-haiku-5-5');
    expect(within(dialog).getByRole('link', { name: 'Алишер' }).getAttribute('href')).toBe('/customers/u1');
    fireEvent.change(within(dialog).getByPlaceholderText(/Комментарий/), { target: { value: 'Не учёл кофеин' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ошибка' }));
    await waitFor(() => expect(calls.find((c) => c.init?.method === 'PATCH')?.init?.body).toBe(JSON.stringify({ review: 'wrong', note: 'Не учёл кофеин' })));
  });
});
