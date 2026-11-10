import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskSheet } from './components/AskSheet';
import { ConfirmProvider } from './components/Confirm';
import { I18nProvider } from './lib/i18n';
import type { Lang, SupportThread } from './lib/types';
import { SupportThreadScreen } from './screens/Support';

/** 6а-Д (D-62), 6б-Б (D-63): «Спросить специалиста» and the request as a messenger chat. */
let posted: { url: string; body: Record<string, unknown> }[];
const thread: SupportThread = {
  id: 't1',
  number: '0012',
  topic: 'promo',
  status: 'answered',
  unread: 0,
  started_by: 'customer',
  rating: null,
  closed_at: null,
  product: { id: 'p1', name: 'Магний B6' },
  order: null,
  last_message_at: '2026-11-09T10:00:00Z',
  created_at: '2026-11-09T09:00:00Z',
  messages: [
    { id: 'm1', author: 'customer', text: 'Есть скидка?', created_at: '2026-11-09T09:00:00Z' },
    { id: 'm2', author: 'staff', text: 'Да, VITA10', created_at: '2026-11-09T10:00:00Z' },
  ],
};
let current: SupportThread;

beforeEach(() => {
  posted = [];
  current = thread;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (init.method === 'POST') posted.push({ url, body: init.body ? JSON.parse(init.body as string) : {} });
    if (url.endsWith('/support/threads') && init.method === 'POST') return json({ ...thread, status: 'open' }, 201);
    if (url.endsWith('/support/threads/t1/messages')) return json({ ...current, status: 'open', messages: [...current.messages, { id: 'm3', author: 'customer', text: 'Спасибо', created_at: '2026-11-09T11:00:00Z' }] }, 201);
    if (url.endsWith('/support/threads/t1/close')) return json({ ...current, status: 'closed', closed_at: '2026-11-09T12:00:00Z' });
    if (url.endsWith('/support/threads/t1/rating')) return json({ ...current, rating: JSON.parse(init.body as string).rating });
    if (url.endsWith('/support/threads/t1')) return json(current);
    return json([]);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(lang: Lang, ui: React.ReactNode, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <ConfirmProvider>
          <Routes>
            <Route path="/" element={ui} />
            <Route path="/support/:id" element={<SupportThreadScreen />} />
          </Routes>
        </ConfirmProvider>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('6б-Б: «Спросить специалиста» sheet', () => {
  it('from the product card: «Тема · Вопрос о товаре» in one row, the list only on a tap; another topic drops the product; then the request number', async () => {
    show('ru', <AskSheet options={{ product: { id: 'p1', name: 'Магний B6' }, topic: 'product' }} onClose={() => undefined} />);
    expect(screen.getByText('Магний B6')).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    const row = screen.getByRole('button', { name: /Тема вопроса/ });
    expect(row.textContent).toContain('Вопрос о товаре');
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('radio', { name: 'Акции и промокоды' }));
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByText('Магний B6')).toBeNull();
    const send = screen.getByRole('button', { name: 'Отправить' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Есть скидка?' } });
    fireEvent.click(send);
    expect(await screen.findByText('Вопрос отправлен')).toBeTruthy();
    expect(screen.getByText('Обращение №0012')).toBeTruthy();
    expect(posted[0]).toEqual({ url: expect.stringContaining('/support/threads'), body: { topic: 'promo', text: 'Есть скидка?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Открыть вопрос' }));
    expect(await screen.findByText('Да, VITA10')).toBeTruthy();
  });

  it('from an order: the topic «По заказу» and the order are attached', async () => {
    show('ru', <AskSheet options={{ order: { id: 'o1', number: 'VTL-26-0042' } }} onClose={() => undefined} />);
    expect(screen.getByRole('button', { name: /Тема вопроса/ }).textContent).toContain('По заказу');
    expect(screen.getByText(/VTL.26.0042/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Когда доставка?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await screen.findByText('Вопрос отправлен');
    expect(posted[0].body).toEqual({ topic: 'order', text: 'Когда доставка?', order_id: 'o1' });
  });

  it('from an order, another topic: the order is no longer attached', () => {
    show('ru', <AskSheet options={{ order: { id: 'o1', number: 'VTL-26-0042' } }} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Тема вопроса/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Технический вопрос' }));
    expect(screen.queryByText(/VTL.26.0042/)).toBeNull();
  });

  it('Uzbek topics', () => {
    show('uz', <AskSheet options={{}} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Savol mavzusi/ }));
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Mahsulot haqida savol', 'Tibbiy savol / Tanlash', 'Buyurtma bo‘yicha', 'Aksiya va promokodlar', 'Texnik savol']);
  });
});

describe('6б-Б: the request as a chat', () => {
  it('the header has the number; the customer answers from the input bar', async () => {
    show('ru', null, '/support/t1');
    expect(await screen.findByRole('heading', { name: 'Обращение №0012' })).toBeTruthy();
    expect(screen.getByText('Специалист VITALO')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Спасибо' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(screen.getByText('Спасибо')).toBeTruthy());
    expect(posted.at(-1)).toEqual({ url: expect.stringContaining('/support/threads/t1/messages'), body: { text: 'Спасибо' } });
  });

  it('a closed request: no input, 1–5 stars, back to the list (no «Новое обращение» inside)', async () => {
    current = { ...thread, status: 'closed', closed_at: '2026-11-09T12:00:00Z' };
    show('ru', null, '/support/t1');
    expect(await screen.findByText('Обращение №0012 закрыто')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Новое обращение' })).toBeNull();
    expect(screen.getByRole('link', { name: 'К списку обращений' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '5 из 5' }));
    expect(await screen.findByText('Спасибо за оценку!')).toBeTruthy();
    expect(posted.at(-1)).toEqual({ url: expect.stringContaining('/support/threads/t1/rating'), body: { rating: 5 } });
  });

  it('the shop answered: the customer closes the request himself (after a confirmation), then rates it', async () => {
    show('ru', null, '/support/t1');
    expect(await screen.findByText('Вопрос решён?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть обращение' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Закрыть' }));
    await waitFor(() => expect(posted.map((p) => p.url).join()).toContain('/close'));
    expect(await screen.findByText('Обращение №0012 закрыто')).toBeTruthy();
    expect(posted.at(-1)?.url).toContain('/support/threads/t1/close');
  });
});
