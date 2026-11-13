import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_CACHED_MS, AI_MIN_MS } from './components/AiCompat';
import { AiChatSheet } from './components/AiChat';
import { CompatBlock } from './components/Compat';
import { I18nProvider } from './lib/i18n';
import type { AiAnswer, AiChat, AiChatState, AiState, CompatState, Lang } from './lib/types';

const compat: CompatState = { eligible: true, products: ['Магний B6', 'Витамин D3'], left_today: 5, request: null };
const answer: AiAnswer = {
  answer_id: 'a1',
  verdict: 'compatible',
  text: 'В наших правилах нет известных конфликтов между этими добавками.',
  timing: [],
  suggestions: [],
  overlaps: [],
  overlap_text: null,
  drugs: [],
  reasons: { synergy: false, spread: false, avoid: false, overlap: false },
};
const ai = (over: Partial<AiState> = {}): AiState => ({ available: true, consent: true, eligible: true, left_today: 1, cached: false, answer: null, ...over });
const chatAnswer: AiChat = {
  id: 'c1',
  number: 'AI-20261112-0001',
  questions: 1,
  messages: [
    { id: 'm1', role: 'user', kind: 'question', text: 'Мне трудно заснуть — что из этого поможет?', created_at: '2026-11-12T10:00:00Z' },
    {
      id: 'm2',
      role: 'ai',
      kind: 'answer',
      text: 'Для сна из вашей корзины может помочь магний.',
      created_at: '2026-11-12T10:00:05Z',
      topic: 'sleep',
      products: [
        { product_id: 'p1', name: 'Магний B6', fit: 'maybe', level: 'B', level_text: 'Есть данные исследований', text: 'Может помочь, если мешает напряжение.', in_cart: true },
        { product_id: 'p2', name: 'Витамин D3', fit: 'no_data', level: null, level_text: null, text: 'Для сна его обычно не берут.', in_cart: true },
      ],
      steps: ['Уберите телефон за час до сна.'],
      followups: ['Как принимать их вместе?'],
      doctor: 'Если проблема держится дольше 3–4 недель — обратитесь к врачу.',
      specialist: true,
    },
  ],
};
const chatState = (over: Partial<AiChatState> = {}): AiChatState => ({
  available: true,
  consent: true,
  left_today: 20,
  max_chars: 300,
  max_turns: 6,
  topics: ['sleep', 'stress', 'energy', 'joints', 'immunity', 'sport'],
  chat: null,
  ...over,
});

let posted: { url: string; body: unknown }[];
function mock(opts: { state?: AiChatState; reply?: { status: number; body: object } } = {}) {
  posted = [];
  const reply = opts.reply ?? { status: 200, body: { chat: chatAnswer, left_today: 19 } };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url.includes('/analytics/events')) return new Response('{}', { status: 202 });
    if (init.method === 'POST') posted.push({ url, body: init.body ? JSON.parse(init.body as string) : null });
    if (url.includes('/cart/items')) return new Response(JSON.stringify({ items: [], warnings: [], items_count: 1, goods_total_uzs: 50000 }));
    if (url.includes('/compat/ai/chat/consent')) return new Response(JSON.stringify(chatState()));
    if (url.includes('/compat/ai/chat/message')) return new Response(JSON.stringify(reply.body), { status: reply.status });
    if (url.includes('/compat/ai/chat')) return new Response(JSON.stringify(opts.state ?? chatState()));
    if (url.includes('/compat/ai/check')) return new Response(JSON.stringify(ai({ result: 'ai', answer })));
    if (url.includes('/compat/ai')) return new Response(JSON.stringify(ai()));
    return new Response(JSON.stringify(compat));
  });
}
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  AI_MIN_MS.value = 0;
  AI_CACHED_MS.value = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openAnswer(lang: Lang = 'ru') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <CompatBlock productIds={['p1', 'p2']} />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /^(?!Спросить |VITALO AI dan ).*VITALO AI/s }));
  await screen.findByRole('region', { name: lang === 'uz' ? 'VITALO AI moslik tahlili' : 'Разбор совместимости VITALO AI' });
}

describe('D-70: VITALO AI at the top of the cart', () => {
  it('the title counts the products; «Скрыть» folds the answer and is remembered; another set — «сверить снова»', async () => {
    mock();
    await openAnswer();
    const card = screen.getByRole('region', { name: 'Разбор совместимости VITALO AI' });
    expect(card.textContent).toContain('Конфликтов не найдено');
    fireEvent.click(within(card).getByRole('button', { name: 'Скрыть' }));
    expect(within(card).queryByText(answer.text)).toBeNull();
    expect(localStorage.getItem('vitalo.ai-folded')).toBe('1');
    fireEvent.click(within(card).getByRole('button', { name: 'Подробнее' }));
    expect(within(card).getByText(answer.text)).toBeTruthy();
    expect(sessionStorage.getItem('vitalo.ai-checked')).toBe('p1,p2');
    cleanup();

    sessionStorage.setItem('vitalo.ai-checked', 'p1,p9');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <I18nProvider lang="ru" setLang={() => undefined}>
            <CompatBlock productIds={['p1', 'p2']} />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('button', { name: /Корзина изменилась — сверить снова/ })).toBeTruthy();
  });
});

const items = [
  { product_id: 'p1', name: 'Магний B6', image_url: null },
  { product_id: 'p2', name: 'Витамин D3', image_url: null },
];
function showCart(lang: Lang = 'ru') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <CompatBlock productIds={['p1', 'p2']} items={items} />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('D-70: «Спросить VITALO AI о корзине» — the conversation', () => {
  it('the window: the cart in short, questions in the customer voice by groups, the text field, the beta line', async () => {
    mock();
    showCart();
    fireEvent.click(await screen.findByRole('button', { name: 'Спросить VITALO AI о корзине' }));
    const sheet = await screen.findByRole('dialog', { name: 'Спросить VITALO AI о корзине' });
    expect(sheet.textContent).toContain('Магний B6, Витамин D3');
    expect(await within(sheet).findByText('О корзине')).toBeTruthy();
    expect(within(sheet).getByText('Что беспокоит')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Можно ли принимать их вместе?' })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Болят и хрустят суставы — что из этого поможет?' })).toBeTruthy();
    expect((within(sheet).getByRole('textbox') as HTMLTextAreaElement).maxLength).toBe(300);
    expect(sheet.textContent).toContain('VITALO AI работает в бета-режиме и пополняет свою базу знаний. Не заменяет консультацию врача.');
  });

  it('a suggested question → the answer: labels in words, tips, the doctor, the specialist, follow-ups that continue the conversation', async () => {
    mock();
    showCart();
    fireEvent.click(await screen.findByRole('button', { name: 'Спросить VITALO AI о корзине' }));
    const sheet = await screen.findByRole('dialog', { name: 'Спросить VITALO AI о корзине' });
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Мне трудно заснуть — что из этого поможет?' }));
    expect(await within(sheet).findByText('Для сна из вашей корзины может помочь магний.')).toBeTruthy();
    expect(posted.filter((p) => p.url.includes('/chat/message'))).toEqual([{ url: '/api/compat/ai/chat/message', body: { text: 'Мне трудно заснуть — что из этого поможет?', suggestion: 'concern' } }]);
    expect(within(sheet).getByText('Поможет при условии')).toBeTruthy();
    expect(within(sheet).getByText('Данных немного')).toBeTruthy();
    expect(within(sheet).getByText('Есть данные исследований')).toBeTruthy();
    expect(within(sheet).getByText('Уберите телефон за час до сна.')).toBeTruthy();
    expect(sheet.textContent).toContain('Если проблема держится дольше 3–4 недель — обратитесь к врачу.');
    expect(sheet.textContent).toContain('AI-20261112-0001');
    expect(sheet.textContent).toContain('Осталось вопросов: 5');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Как принимать их вместе?' }));
    await waitFor(() => expect(posted.filter((p) => p.url.includes('/chat/message')).at(-1)!.body).toEqual({ text: 'Как принимать их вместе?', chat_id: 'c1', suggestion: 'followup' }));
    fireEvent.click(within(sheet).getByRole('button', { name: /Спросить специалиста VITALO/ }));
    expect(screen.getByRole('dialog', { name: 'Проверить совместимость у специалиста' })).toBeTruthy();
  });

  it('own text; the limit: a plain message and the specialist', async () => {
    mock({ reply: { status: 429, body: { code: 'AI_DAILY_LIMIT' } } });
    showCart();
    fireEvent.click(await screen.findByRole('button', { name: 'Спросить VITALO AI о корзине' }));
    const sheet = await screen.findByRole('dialog', { name: 'Спросить VITALO AI о корзине' });
    fireEvent.change(await within(sheet).findByRole('textbox'), { target: { value: 'Можно пить магний с кофе?' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Отправить' }));
    expect(await within(sheet).findByText(/Сегодня вопросов больше нет/)).toBeTruthy();
    expect(posted.at(-1)!.body).toEqual({ text: 'Можно пить магний с кофе?' });
    expect(within(sheet).getByRole('button', { name: /Спросить специалиста VITALO/ })).toBeTruthy();
  });

  it('the consent of D-70 is asked in the window; 6 questions used — «Новый разговор»', async () => {
    mock({ state: chatState({ consent: false }) });
    showCart();
    fireEvent.click(await screen.findByRole('button', { name: 'Спросить VITALO AI о корзине' }));
    const sheet = await screen.findByRole('dialog', { name: 'Спросить VITALO AI о корзине' });
    expect(await within(sheet).findByText(/хранится у VITALO 12 месяцев/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Я согласен' }));
    expect(await within(sheet).findByText('О корзине')).toBeTruthy();
    cleanup();

    // the saved conversation is about this very cart — it continues
    localStorage.setItem('vitalo.aichat.cart', JSON.stringify({ id: 'c1', sig: 'p1,p2' }));
    mock({ state: chatState({ chat: { ...chatAnswer, questions: 6 } }) });
    showCart();
    fireEvent.click(await screen.findByRole('button', { name: 'Спросить VITALO AI о корзине' }));
    const full = await screen.findByRole('dialog', { name: 'Спросить VITALO AI о корзине' });
    expect(await within(full).findByText('В этом разговоре вопросов больше нет. Начните новый.')).toBeTruthy();
    expect(within(full).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(full).getAllByRole('button', { name: 'Новый разговор' }).at(-1)!);
    expect(within(full).getByRole('textbox')).toBeTruthy();
    expect(within(full).getByText('О корзине')).toBeTruthy();
  });

  it('the cart is another one than in the saved conversation: a new conversation opens; the tools are «Новый чат» and the bin', async () => {
    localStorage.setItem('vitalo.aichat.cart', JSON.stringify({ id: 'c1', sig: 'p1,p9' }));
    mock({ state: chatState({ chat: chatAnswer }) });
    showCart();
    fireEvent.click(await screen.findByRole('button', { name: 'Спросить VITALO AI о корзине' }));
    const sheet = await screen.findByRole('dialog', { name: 'Спросить VITALO AI о корзине' });
    expect(await within(sheet).findByText('О корзине')).toBeTruthy();
    expect(within(sheet).queryByText('AI-20261112-0001')).toBeNull();
    cleanup();

    localStorage.setItem('vitalo.aichat.cart', JSON.stringify({ id: 'c1', sig: 'p1,p2' }));
    mock({ state: chatState({ chat: chatAnswer }) });
    showCart();
    fireEvent.click(await screen.findByRole('button', { name: 'Спросить VITALO AI о корзине' }));
    const same = await screen.findByRole('dialog', { name: 'Спросить VITALO AI о корзине' });
    expect(await within(same).findByText('AI-20261112-0001')).toBeTruthy();
    expect(within(same).getByRole('button', { name: 'Новый чат' })).toBeTruthy();
    expect(within(same).getByRole('button', { name: 'Удалить переписку' }).textContent).toBe('');
  });

  it('Uzbek: the button and the questions', async () => {
    mock();
    showCart('uz');
    fireEvent.click(await screen.findByRole('button', { name: 'VITALO AI dan savat haqida soʻrash' }));
    const sheet = await screen.findByRole('dialog', { name: 'VITALO AI dan savat haqida soʻrash' });
    expect(await within(sheet).findByRole('button', { name: 'Boʻgʻimlarim ogʻriydi va qisirlaydi — bulardan qaysi biri yordam beradi?' })).toBeTruthy();
  });
});

describe('D-70: an empty cart — products of the catalogue with «В корзину»', () => {
  it('the answer offers a product of the catalogue; «В корзину» adds it once', async () => {
    const pick: AiChat = {
      ...chatAnswer,
      messages: [
        chatAnswer.messages[0],
        {
          ...chatAnswer.messages[1],
          products: [{ product_id: 'p7', name: 'Магний глицинат', fit: 'helps', level: 'B', level_text: 'Есть данные исследований', text: 'Может помочь при напряжении.', in_cart: false }],
        },
      ],
    };
    localStorage.setItem('vitalo.aichat.cart', JSON.stringify({ id: 'c1', sig: '' }));
    mock({ state: chatState({ chat: pick }) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <I18nProvider lang="ru" setLang={() => undefined}>
            <AiChatSheet items={[]} onClose={() => undefined} />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const sheet = await screen.findByRole('dialog', { name: 'Спросить VITALO AI' });
    const add = await within(sheet).findByRole('button', { name: 'В корзину' });
    fireEvent.click(add);
    await waitFor(() => expect(within(sheet).getByRole('button', { name: 'В корзине' }).hasAttribute('disabled')).toBe(true));
    expect(posted.filter((p) => p.url.includes('/cart/items'))).toEqual([{ url: '/api/cart/items', body: { product_id: 'p7', qty: 1 } }]);
  });
});
