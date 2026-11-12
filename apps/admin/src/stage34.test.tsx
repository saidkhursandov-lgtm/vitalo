import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StaffAuthProvider, type Permission } from './lib/auth';
import { setToken } from './lib/api';
import { navFor } from './lib/nav';
import { MemoryRouter } from 'react-router-dom';
import { Compat, type CompatRequestRow } from './pages/Compat';

const row = (over: Partial<CompatRequestRow> = {}): CompatRequestRow => ({
  id: 'r1',
  created_at: '2026-11-01T10:00:00Z',
  status: 'pending',
  source: 'specialist',
  lang: 'uz',
  customer: 'Ali V.',
  products: [
    { product_id: 'a', sku: 'OZN-A001', name: 'Магний B6' },
    { product_id: 'b', sku: 'OZN-A002', name: 'Железо' },
  ],
  has_comment: true,
  comment: 'Пью варфарин',
  comment_hidden: false,
  comment_purged: false,
  verdict: null,
  answer_text: null,
  answered_by: null,
  answered_at: null,
  saved: false,
  ...over,
});
const templates = {
  compatible: { ru: 'Можно вместе.', uz: 'Birga mumkin.' },
  spread: { ru: 'Разнесите.', uz: 'Ajrating.' },
  consult: { ru: 'Нужна консультация.', uz: 'Maslahat kerak.' },
};

let posted: { url: string; body: unknown }[];
function mock(permissions: Permission[], rows: CompatRequestRow[]) {
  posted = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url.includes('/staff/auth/me')) return json({ staff: { id: 's1', name: 'Мадина', role: 'marketer' }, permissions });
    if (init.method === 'POST') {
      posted.push({ url, body: JSON.parse(init.body as string) });
      return json({ result: 'answered' });
    }
    if (url.includes('/staff/compat/templates')) return json(templates);
    if (url.includes('/staff/compat/requests')) return json(rows);
    return json([]);
  });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setToken(null);
});

function show() {
  setToken('t');
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StaffAuthProvider>
        <MemoryRouter>
          <Compat />
        </MemoryRouter>
      </StaffAuthProvider>
    </QueryClientProvider>,
  );
}

describe('3.4 Совместимость', () => {
  it('in the menu for the manager (view) and the specialist; not for warehouse', () => {
    expect(navFor(['compat.view']).map((n) => n.label)).toEqual(['Вопросы о совместимости', 'База знаний AI']); // генплан, этап 2
    expect(navFor(['orders.view', 'inventory.view']).map((n) => n.label)).not.toContain('Вопросы о совместимости');
  });

  it('a manager sees the request but not the comment, and cannot answer', async () => {
    mock(['compat.view'], [row({ comment: null, comment_hidden: true })]);
    show();
    expect(await screen.findByText('есть, скрыт (видит специалист)')).toBeTruthy();
    expect(screen.queryByText('Пью варфарин')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ответить' })).toBeNull();
  });

  it('a specialist answers: label, the template in the customer language, «Можно использовать повторно»', async () => {
    mock(['compat.view', 'compat.answer'], [row()]);
    show();
    expect(await screen.findByText('Пью варфарин')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ответить' }));
    const text = (await screen.findByDisplayValue('Birga mumkin.')) as HTMLTextAreaElement; // UZ customer → UZ template
    fireEvent.click(screen.getByRole('button', { name: 'Разнести по времени' }));
    await waitFor(() => expect(text.value).toBe('Ajrating.'));
    fireEvent.change(text, { target: { value: 'Magniy — kechqurun.' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Отправить клиенту' }));
    await waitFor(() => expect(posted).toEqual([{ url: '/api/staff/compat/requests/r1/answer', body: { verdict: 'spread', text: 'Magniy — kechqurun.', reuse: true } }]));
  });

  it('a comment older than 90 days shows as removed', async () => {
    mock(['compat.view', 'compat.answer'], [row({ comment: null, comment_purged: true })]);
    show();
    expect(await screen.findByText('удалён через 90 дней')).toBeTruthy();
  });
});

describe('Шаг 0а-3: «Сохранённые сочетания» — «пересмотреть», когда у VITALO AI другая метка', () => {
  const saved = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    lang: 'ru',
    verdict: 'consult',
    text: 'Нужна консультация.',
    enabled: true,
    products: row().products,
    author: 'Мадина',
    used: 3,
    updated_at: '2026-11-01T10:00:00Z',
    review_needed_at: '2026-11-12T10:00:00Z',
    review_ai_verdict: 'compatible',
    ...over,
  });

  it('the mark, the AI label, the filter and «Ответ верен»', async () => {
    const patched: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
      if (url.includes('/staff/auth/me')) return json({ staff: { id: 's1', name: 'Мадина', role: 'admin' }, permissions: ['compat.view', 'compat.answer'] });
      if (init.method === 'PATCH') {
        patched.push({ url, body: JSON.parse(init.body as string) });
        return json([saved({ review_needed_at: null }), saved({ id: 'a2', review_needed_at: null, text: 'Другое.' })]);
      }
      if (url.includes('/staff/compat/answers')) return json([saved(), saved({ id: 'a2', review_needed_at: null, text: 'Другое.' })]);
      return json([]);
    });
    setToken('t');
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <StaffAuthProvider>
          <MemoryRouter initialEntries={['/compat?tab=saved']}>
            <Compat />
          </MemoryRouter>
        </StaffAuthProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Пересмотреть — правила изменились')).toBeTruthy();
    expect(screen.getByText(/Пересмотреть: 1\./)).toBeTruthy();
    expect(screen.getByText(/VITALO AI сейчас: Совместимы/)).toBeTruthy();
    expect(screen.getByText('Другое.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /Только «пересмотреть»/ }));
    expect(screen.queryByText('Другое.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ответ верен' }));
    await waitFor(() => expect(patched).toEqual([{ url: '/api/staff/compat/answers/a1', body: { reviewed: true } }]));
    await waitFor(() => expect(screen.queryByText('Пересмотреть — правила изменились')).toBeNull());
  });
});

describe('Шаг 0б: «База знаний AI → Цели» (D-69)', () => {
  const goalRow = (over: Record<string, unknown> = {}) => ({
    id: 'g1',
    substance: { id: 's1', name_ru: 'Магний' },
    goal: 'sleep',
    level: 'B',
    helps_ru: 'при напряжении',
    helps_uz: 'zoʻriqishda',
    not_helps_ru: 'если мешает кофеин',
    not_helps_uz: 'kofein xalaqit bersa',
    source: 'обзор',
    status: 'draft',
    approved_by: null,
    approved_at: null,
    updated_at: '2026-11-12T10:00:00Z',
    ...over,
  });

  function showGoals(permissions: Permission[]) {
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
      if (url.includes('/staff/auth/me')) return json({ staff: { id: 's1', name: 'Мадина', role: 'admin' }, permissions });
      if (init.method === 'POST') {
        posts.push({ url, body: JSON.parse(init.body as string) });
        return json([goalRow({ status: 'approved', approved_by: 'Мадина', approved_at: '2026-11-12T11:00:00Z' })]);
      }
      if (url.includes('/staff/compat/goals')) return json([goalRow(), goalRow({ id: 'g2', goal: 'energy', substance: { id: 's2', name_ru: 'Железо' } })]);
      return json([]);
    });
    setToken('t');
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <StaffAuthProvider>
          <MemoryRouter initialEntries={['/compat?tab=goals']}>
            <Compat />
          </MemoryRouter>
        </StaffAuthProvider>
      </QueryClientProvider>,
    );
    return posts;
  }

  it('the rows with the level, the goal filter; an admin approves', async () => {
    const posts = showGoals(['compat.view', 'compat.answer', 'compat.rules.approve']);
    expect(await screen.findByText('Магний')).toBeTruthy();
    expect(screen.getAllByText('B — Есть данные исследований').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /^Энергия/ }));
    expect(screen.queryByText('Магний')).toBeNull();
    expect(screen.getByText('Железо')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Одобрить' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/staff/compat/goals/g2/status', body: { status: 'approved' } }]));
  });

  it('a manager only looks', async () => {
    showGoals(['compat.view']);
    expect(await screen.findByText('Магний')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Одобрить' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Строка' })).toBeNull();
  });
});
