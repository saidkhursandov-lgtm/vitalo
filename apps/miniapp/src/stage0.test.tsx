import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_CACHED_MS, AI_MIN_MS } from './components/AiCompat';
import { CompatBlock } from './components/Compat';
import { I18nProvider } from './lib/i18n';
import type { AiAnswer, AiGoalAnswer, AiState, CompatState, Lang } from './lib/types';

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
const goal: AiGoalAnswer = {
  goal: 'sleep',
  duration: '2to4w',
  kind: 'fall_asleep',
  summary: 'Для сна в этом наборе может помочь магний, витамин D3 для этой цели можно не брать.',
  products: [
    { product_id: 'p1', name: 'Магний B6', fit: 'maybe', level: 'B', level_text: 'Есть данные исследований', text: 'Может помочь, если мешает напряжение.' },
    { product_id: 'p2', name: 'Витамин D3', fit: 'no_data', level: null, level_text: null, text: 'Данных немного: может помочь, если его мало в рационе.' },
  ],
  steps: ['Ложитесь в одно и то же время.', 'Уберите телефон за час до сна.'],
  doctor: 'Если проблема держится дольше 3–4 недель — обратитесь к врачу.',
  left_today: 19,
};

let posted: { url: string; body: unknown }[];
function mock(goalReply: { status: number; body: object } = { status: 200, body: goal }) {
  posted = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url.includes('/analytics/events')) return new Response('{}', { status: 202 });
    if (init.method === 'POST') posted.push({ url, body: init.body ? JSON.parse(init.body as string) : null });
    if (url.includes('/compat/ai/goal')) return new Response(JSON.stringify(goalReply.body), { status: goalReply.status });
    if (url.includes('/compat/ai/check')) return new Response(JSON.stringify(ai({ result: 'ai', answer })));
    if (url.includes('/compat/ai')) return new Response(JSON.stringify(ai()));
    return new Response(JSON.stringify(compat));
  });
}
beforeEach(() => {
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
  fireEvent.click(await screen.findByRole('button', { name: /VITALO AI/ }));
  await screen.findByRole('region', { name: lang === 'uz' ? 'VITALO AI moslik tahlili' : 'Разбор совместимости VITALO AI' });
}

describe('Шаг 0б: «Задать вопрос VITALO AI по корзине» (D-68, D-69)', () => {
  it('appears only under the AI answer and is folded; no text field anywhere', async () => {
    mock();
    await openAnswer();
    const toggle = screen.getByRole('button', { name: 'Задать вопрос VITALO AI по корзине' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Поможет ли этот набор для моей цели?')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Поможет ли этот набор для моей цели?' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('goal → how long → what exactly; only the chips are sent; the answer: levels in words, steps, the doctor, the specialist', async () => {
    mock();
    await openAnswer();
    fireEvent.click(screen.getByRole('button', { name: 'Задать вопрос VITALO AI по корзине' }));
    fireEvent.click(screen.getByRole('button', { name: 'Поможет ли этот набор для моей цели?' }));
    for (const g of ['Сон', 'Стресс', 'Энергия', 'Суставы', 'Иммунитет', 'Спорт']) expect(screen.getByRole('button', { name: g })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Сон' }));
    expect(screen.getByText('Как давно беспокоит?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '2–4 недели' }));
    expect(screen.getByText('Что именно?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Трудно заснуть' }));

    const card = await screen.findByRole('region', { name: 'Ответ VITALO AI' });
    expect(posted.filter((p) => p.url.includes('/compat/ai/goal'))).toEqual([{ url: '/api/compat/ai/goal', body: { goal: 'sleep', duration: '2to4w', kind: 'fall_asleep' } }]);
    expect(card.textContent).toContain('Ответ VITALO AI: сон');
    expect(within(card).getByText('Поможет при условии')).toBeTruthy();
    expect(within(card).getByText('Данных немного')).toBeTruthy();
    expect(within(card).getByText('Есть данные исследований')).toBeTruthy();
    expect(card.textContent).not.toMatch(/уровень|\bB\b/);
    expect(within(card).getByText('Уберите телефон за час до сна.')).toBeTruthy();
    expect(card.textContent).toContain('Если проблема держится дольше 3–4 недель — обратитесь к врачу.');
    fireEvent.click(within(card).getByRole('button', { name: /Спросить специалиста VITALO/ }));
    expect(screen.getByRole('dialog', { name: 'Проверить совместимость у специалиста' })).toBeTruthy();
  });

  it('the limit and a failure: a plain message and the way to the specialist', async () => {
    mock({ status: 429, body: { code: 'AI_DAILY_LIMIT' } });
    await openAnswer();
    fireEvent.click(screen.getByRole('button', { name: 'Задать вопрос VITALO AI по корзине' }));
    fireEvent.click(screen.getByRole('button', { name: 'Поможет ли этот набор для моей цели?' }));
    fireEvent.click(screen.getByRole('button', { name: 'Энергия' }));
    fireEvent.click(screen.getByRole('button', { name: 'Дольше месяца' }));
    fireEvent.click(screen.getByRole('button', { name: 'Спад после обеда' }));
    expect(await screen.findByText(/Сегодня вопросов больше нет/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Спросить специалиста VITALO/ }).length).toBeGreaterThan(0);
  });

  it('Uzbek: the toggle and the chips', async () => {
    mock();
    await openAnswer('uz');
    fireEvent.click(screen.getByRole('button', { name: 'VITALO AI ga savat boʻyicha savol berish' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bu toʻplam maqsadimga yordam beradimi?' }));
    expect(screen.getByRole('button', { name: 'Boʻgʻimlar' })).toBeTruthy();
  });
});
