import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StaffAuthProvider, type Permission } from './lib/auth';
import { setToken } from './lib/api';
import { Compat } from './pages/Compat';
import type { AiAnswerRow } from './pages/CompatAi';
import { VitaloAiSettings, type AiSettingsView } from './pages/settings/VitaloAi';

const row = (over: Partial<AiAnswerRow> = {}): AiAnswerRow => ({
  id: 'a1',
  created_at: '2026-11-03T10:00:00Z',
  lang: 'ru',
  verdict: 'spread',
  text: 'Магний вечером, D3 утром с едой.',
  products: [
    { product_id: 'p1', sku: 'OZN-A001', name: 'Магний B6' },
    { product_id: 'p2', sku: 'OZN-A002', name: 'Витамин D3' },
  ],
  timing: [
    { name: 'Магний B6', when: 'Вечер' },
    { name: 'Витамин D3', when: 'Утро, с едой' },
  ],
  suggestions: 0,
  model: 'claude-haiku-5-5',
  cost_usd: 0.0003,
  used: 2,
  review: 'new',
  reviewed_by: null,
  reviewed_at: null,
  urgent: false,
  ...over,
});
const settings = (over: Partial<AiSettingsView> = {}): AiSettingsView => ({
  settings: { enabled: true, model: 'claude-haiku-5-5', monthly_budget_usd: 10, cart_daily_limit: 1, chat_daily_limit: 20 },
  defaults: { enabled: true, model: 'claude-haiku-5-5', monthly_budget_usd: 10, cart_daily_limit: 1, chat_daily_limit: 20 },
  key_set: true,
  models: [
    { id: 'claude-haiku-5-5', input: 0.1, output: 0.5 },
    { id: 'claude-sonnet-5-5', input: 2, output: 10 },
  ],
  today: { requests: 3, cost_usd: 0.0012 },
  month: { requests: 40, cost_usd: 8.5 },
  month_failed: 2,
  ...over,
});

let sent: { url: string; method: string; body: unknown }[];
function mock(permissions: Permission[], answers: AiAnswerRow[], view: AiSettingsView = settings()) {
  sent = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url.includes('/staff/auth/me')) return json({ staff: { id: 's1', name: 'Мадина', role: 'admin' }, permissions });
    if (init.method === 'POST' || init.method === 'PUT') {
      const body = JSON.parse(init.body as string);
      sent.push({ url, method: init.method, body });
      return json(url.includes('/staff/ai/settings') ? { ...view, settings: body.settings } : answers);
    }
    if (url.includes('/staff/ai/answers')) return json(answers);
    if (url.includes('/staff/ai/settings')) return json(view);
    return json([]);
  });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setToken(null);
});
function show(node: ReactNode) {
  setToken('t');
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <StaffAuthProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </StaffAuthProvider>
    </QueryClientProvider>,
  );
}
const openAiTab = async () => fireEvent.click(await screen.findByRole('button', { name: 'AI-ответы' }));

describe('3.8 Совместимость → AI-ответы', () => {
  it('red answers come first with «Проверить в первую очередь»; text, times, model and cost are shown', async () => {
    mock(['compat.view', 'compat.answer'], [row({ id: 'red', verdict: 'consult', urgent: true }), row()]);
    show(<Compat />);
    await openAiTab();
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(rows[0].textContent).toContain('Проверить в первую очередь');
    expect(rows[0].textContent).toContain('Нужна консультация');
    expect(rows[0].className).toContain('row-urgent');
    expect(rows[1].textContent).not.toContain('Проверить в первую очередь');
    expect(rows[1].textContent).toContain('Витамин D3: Утро, с едой');
    expect(rows[1].textContent).toContain('claude-haiku-5-5 · $0.0003');
    expect(rows[1].textContent).toContain('2 раз');
  });

  it('«Одобрить и сохранить» and «Скрыть» send the action; «Все» shows reviewed ones', async () => {
    mock(['compat.view', 'compat.answer'], [row()]);
    show(<Compat />);
    await openAiTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Одобрить и сохранить' }));
    await waitFor(() => expect(sent).toEqual([{ url: '/api/staff/ai/answers/a1/review', method: 'POST', body: { action: 'approve' } }]));
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть' }));
    await waitFor(() => expect(sent[1].body).toEqual({ action: 'hide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Все' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Все' }).className).toContain('is-on'));
  });

  it('«Исправить»: the specialist changes the label and the text', async () => {
    mock(['compat.view', 'compat.answer'], [row()]);
    show(<Compat />);
    await openAiTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Исправить' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Нужна консультация' }));
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Уточните у врача.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(sent).toEqual([{ url: '/api/staff/ai/answers/a1/review', method: 'POST', body: { action: 'fix', verdict: 'consult', text: 'Уточните у врача.' } }]));
  });

  it('a manager only looks: no buttons', async () => {
    mock(['compat.view'], [row()]);
    show(<Compat />);
    await openAiTab();
    await screen.findByText('Магний вечером, D3 утром с едой.');
    expect(screen.queryByRole('button', { name: /Одобрить|Исправить|Скрыть/ })).toBeNull();
  });
});

describe('3.8 Настройки → VITALO AI', () => {
  it('the state, the spend of the month against the budget; saving sends all fields', async () => {
    mock(['settings.manage'], []);
    show(<VitaloAiSettings />);
    expect(await screen.findByText('Работает')).toBeTruthy();
    expect(screen.getByText(/\$8\.50/).closest('p')!.textContent).toContain('из $10');
    expect(screen.getByText('85%')).toBeTruthy();
    expect(screen.getByText(/в этом месяце: 2/)).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'claude-sonnet-5-5' } });
    fireEvent.change(screen.getByLabelText(/Бюджет на месяц/), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(sent).toEqual([
        { url: '/api/staff/ai/settings', method: 'PUT', body: { settings: { enabled: true, model: 'claude-sonnet-5-5', monthly_budget_usd: 25, cart_daily_limit: 1, chat_daily_limit: 20 } } },
      ]),
    );
  });

  it('no key on the server and a spent budget are said plainly', async () => {
    mock(['settings.manage'], [], settings({ key_set: false }));
    show(<VitaloAiSettings />);
    expect(await screen.findByText('Нет ключа Claude на сервере')).toBeTruthy();
    expect(screen.getByText(/вписывают в файл .env на сервере/)).toBeTruthy();
    cleanup();
    mock(['settings.manage'], [], settings({ month: { requests: 90, cost_usd: 10.2 } }));
    show(<VitaloAiSettings />);
    expect(await screen.findByText('Бюджет месяца исчерпан — отвечает специалист')).toBeTruthy();
  });
});
