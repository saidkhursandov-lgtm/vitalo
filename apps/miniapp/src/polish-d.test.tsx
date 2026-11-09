import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskSheet } from './components/AskSheet';
import { I18nProvider } from './lib/i18n';
import type { Lang, SupportThread } from './lib/types';
import { SupportThreadScreen } from './screens/Support';

/** 6а-Д (D-62): «Спросить специалиста» inside the Mini App and the conversation in «Личные». */
let posted: { url: string; body: Record<string, unknown> }[];
const thread: SupportThread = {
  id: 't1',
  topic: 'promo',
  status: 'answered',
  unread: 0,
  product: { id: 'p1', name: 'Магний B6' },
  last_message_at: '2026-11-09T10:00:00Z',
  created_at: '2026-11-09T09:00:00Z',
  messages: [
    { id: 'm1', author: 'customer', text: 'Есть скидка?', created_at: '2026-11-09T09:00:00Z' },
    { id: 'm2', author: 'staff', text: 'Да, VITA10', created_at: '2026-11-09T10:00:00Z' },
  ],
};

beforeEach(() => {
  posted = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (init.method === 'POST') posted.push({ url, body: JSON.parse(init.body as string) });
    if (url.endsWith('/support/threads') && init.method === 'POST') return json({ ...thread, status: 'open' }, 201);
    if (url.endsWith('/support/threads/t1/messages')) return json({ ...thread, status: 'open', messages: [...thread.messages, { id: 'm3', author: 'customer', text: 'Спасибо', created_at: '2026-11-09T11:00:00Z' }] }, 201);
    if (url.endsWith('/support/threads/t1')) return json(thread);
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
          <Routes>
            <Route path="/" element={ui} />
            <Route path="/support/:id" element={<SupportThreadScreen />} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('6а-Д: «Спросить специалиста» sheet', () => {
  it('from the product card: the product is attached; a topic chip and the text are sent; then «Вопрос отправлен»', async () => {
    show('ru', <AskSheet options={{ product: { id: 'p1', name: 'Магний B6' }, topic: 'medical' }} onClose={() => undefined} />);
    expect(screen.getByText('Магний B6')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Медицинский вопрос / Подбор' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/не заменяет консультацию врача/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Акции и промокоды' }));
    const send = screen.getByRole('button', { name: 'Отправить' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Есть скидка?' } });
    fireEvent.click(send);
    expect(await screen.findByText('Вопрос отправлен')).toBeTruthy();
    expect(posted[0]).toEqual({ url: expect.stringContaining('/support/threads'), body: { topic: 'promo', text: 'Есть скидка?', product_id: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Открыть вопрос' }));
    expect(await screen.findByText('Да, VITA10')).toBeTruthy();
  });

  it('Uzbek chips', () => {
    show('uz', <AskSheet options={{}} onClose={() => undefined} />);
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Tibbiy savol / Tanlash', 'Buyurtma bo‘yicha', 'Aksiya va promokodlar', 'Texnik savol']);
  });
});

describe('6а-Д: the conversation', () => {
  it('the specialist reply is shown; the customer answers inside the Mini App', async () => {
    show('ru', null, '/support/t1');
    expect(await screen.findByText('Специалист VITALO')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Спасибо' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(screen.getByText('Спасибо')).toBeTruthy());
    expect(posted.at(-1)).toEqual({ url: expect.stringContaining('/support/threads/t1/messages'), body: { text: 'Спасибо' } });
  });
});
