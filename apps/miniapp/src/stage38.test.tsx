import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_MIN_MS } from './components/AiCompat';
import { CompatBlock } from './components/Compat';
import { I18nProvider } from './lib/i18n';
import type { AiAnswer, AiState, CompatState, Lang } from './lib/types';

const compat = (over: Partial<CompatState> = {}): CompatState => ({ eligible: true, products: ['Магний B6', 'Витамин D3'], left_today: 5, request: null, ...over });
const ai = (over: Partial<AiState> = {}): AiState => ({ available: true, consent: true, eligible: true, left_today: 1, answer: null, ...over });
const answer = (over: Partial<AiAnswer> = {}): AiAnswer => ({
  answer_id: 'a1',
  verdict: 'spread',
  text: 'Магний лучше вечером, D3 — утром с едой.',
  timing: [
    { product_id: 'p1', name: 'Магний B6', when: 'Вечер' },
    { product_id: 'p2', name: 'Витамин D3', when: 'Утро, с едой' },
  ],
  suggestions: [],
  overlaps: ['Витамин B6'],
  overlap_text: 'Одно вещество есть в нескольких товарах — проверьте суммарную дозировку или уточните у специалиста',
  drugs: ['Железо может снижать усвоение L-тироксина. Обычно их разносят минимум на 4 часа.'],
  ...over,
});

let calls: { url: string; method: string }[];
let events: { event: string; props?: Record<string, unknown> }[];

/** GET /compat → `c`, GET /compat/ai → `a`; POST /compat/ai/consent and /check → the given replies. */
function mock(c: CompatState, a: AiState, replies: { consent?: AiState; check?: { status: number; body: object } } = {}) {
  calls = [];
  events = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method });
    if (url.includes('/analytics/events')) {
      events.push(JSON.parse(init.body as string));
      return new Response('{}', { status: 202 });
    }
    if (url.includes('/compat/ai/consent')) return new Response(JSON.stringify(replies.consent ?? { ...a, consent: true }));
    if (url.includes('/compat/ai/check')) return new Response(JSON.stringify(replies.check?.body ?? {}), { status: replies.check?.status ?? 200 });
    if (url.includes('/compat/ai')) return new Response(JSON.stringify(a));
    return new Response(JSON.stringify(c));
  });
}
beforeEach(() => {
  AI_MIN_MS.value = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(lang: Lang = 'ru', ids = ['p1', 'p2']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <CompatBlock productIds={ids} />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.url.includes(path)).length;

describe('3.8 VITALO AI in the cart', () => {
  it('the hint and «Проверить совместимость (VITALO AI)» above the specialist button', async () => {
    mock(compat(), ai());
    show();
    expect(await screen.findByText(/Не знаете, как сочетать выбранные добавки\?/)).toBeTruthy();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons[0]).toContain('Проверить совместимость (VITALO AI)');
    expect(buttons[1]).toContain('Проверить совместимость у специалиста');
  });

  it('one product: «С чем сочетать этот препарат?», no specialist button', async () => {
    mock(compat({ eligible: false, products: ['Магний B6'] }), ai());
    show('ru', ['p1']);
    expect(await screen.findByRole('button', { name: /С чем сочетать этот препарат\?/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /у специалиста/ })).toBeNull();
  });

  it('no key or switched off: only the specialist, as in 3.4', async () => {
    mock(compat(), ai({ available: false }));
    show();
    await screen.findByRole('button', { name: /Проверить совместимость у специалиста/ });
    expect(screen.queryByText(/VITALO AI/)).toBeNull();
  });

  it('first time: the consent, then the check; the card shows the label, times, repeats and medicine lines', async () => {
    mock(compat(), ai({ consent: false }), { check: { status: 200, body: ai({ result: 'ai', left_today: 0, answer: answer() }) } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Проверить совместимость \(VITALO AI\)/ }));
    const dialog = screen.getByRole('dialog', { name: 'Перед началом' });
    expect(dialog.textContent).toContain('не ставит диагнозы и не заменяет консультацию врача');
    expect(dialog.textContent).toContain('Нажимая «Я согласен», вы принимаете Правила использования VITALO AI и Политику конфиденциальности.');
    expect(within(dialog).getByRole('link', { name: 'Политику конфиденциальности' }).getAttribute('href')).toBe('/legal/privacy');
    expect(posts('/compat/ai/check')).toBe(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Я согласен' }));

    const card = await screen.findByRole('region', { name: 'VITALO AI' });
    expect(posts('/compat/ai/consent')).toBe(1);
    expect(posts('/compat/ai/check')).toBe(1);
    expect(card.textContent).toContain('Разнести по времени');
    expect(card.textContent).toContain('VITALO AI · по правилам отбора VITALO');
    expect(card.textContent).toContain('Утро, с едой');
    expect(card.textContent).toContain('проверьте суммарную дозировку или уточните у специалиста (Витамин B6)');
    expect(card.textContent).toContain('минимум на 4 часа');
    expect(card.textContent).toContain('Если принимаете лекарства — уточните у врача');
    expect(card.textContent).toContain('Не является медицинской консультацией');
    expect(screen.queryByRole('button', { name: /Проверить совместимость \(VITALO AI\)/ })).toBeNull();
    // «Спросить специалиста» opens the 3.4 sheet
    fireEvent.click(within(card).getByRole('button', { name: 'Спросить специалиста' }));
    expect(screen.getByRole('dialog', { name: 'Проверить совместимость у специалиста' })).toBeTruthy();
    await waitFor(() => expect(events.map((e) => e.event)).toContain('compat_view'));
    expect(events.find((e) => e.event === 'compat_view')!.props).toMatchObject({ source: 'ai', verdict: 'spread' });
  });

  it('the animation statuses while the answer is coming; no motion asked by the system is kept in CSS', async () => {
    AI_MIN_MS.value = 300;
    mock(compat(), ai(), { check: { status: 200, body: ai({ result: 'ai_cache', answer: answer({ overlaps: [], overlap_text: null, drugs: [] }) }) } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /VITALO AI/ }));
    expect(await screen.findByText('Анализируем состав и формы веществ…')).toBeTruthy();
    const card = await screen.findByRole('region', { name: 'VITALO AI' });
    expect(card.textContent).not.toContain('суммарную дозировку');
  });

  it('one product: suggestions in stock are links to the product', async () => {
    mock(compat({ eligible: false, products: ['Магний B6'] }), ai({ answer: answer({ verdict: 'compatible', timing: [], overlaps: [], overlap_text: null, suggestions: [{ product_id: 'p9', name: 'Витамин D3 2000' }] }) }));
    show('ru', ['p1']);
    const link = await screen.findByRole('link', { name: /Витамин D3 2000/ });
    expect(link.getAttribute('href')).toBe('/product/p9');
    expect(screen.queryByRole('button', { name: 'Спросить специалиста' })).toBeNull();
  });

  it('the daily limit: the message and «Написать специалисту»', async () => {
    mock(compat(), ai({ left_today: 0 }), { check: { status: 429, body: { code: 'AI_DAILY_LIMIT' } } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /VITALO AI/ }));
    expect(await screen.findByText(/Бесплатная AI-проверка доступна 1 раз в день/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Написать специалисту' }));
    expect(screen.getByRole('dialog', { name: 'Проверить совместимость у специалиста' })).toBeTruthy();
  });

  it('the AI could not answer: «Ответ готовит специалист VITALO — пришлём в бот»', async () => {
    mock(compat(), ai(), { check: { status: 200, body: ai({ result: 'specialist', reason: 'invalid' }) } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /VITALO AI/ }));
    expect(await screen.findByText('Ответ готовит специалист VITALO — пришлём в бот')).toBeTruthy();
  });

  it('Uzbek: the button, the consent and «Roziman» fit the texts of the spec', async () => {
    mock(compat(), ai({ consent: false }));
    show('uz');
    fireEvent.click(await screen.findByRole('button', { name: /Moslikni tekshirish \(VITALO AI\)/ }));
    const dialog = screen.getByRole('dialog', { name: 'Boshlashdan oldin' });
    expect(dialog.textContent).toContain('«Roziman» tugmasini bosish orqali siz VITALO AI dan foydalanish qoidalari va Maxfiylik siyosatini qabul qilasiz.');
    expect(within(dialog).getByRole('button', { name: 'Roziman' })).toBeTruthy();
  });
});

describe('3.8 the VITALO AI slide of the home banner', () => {
  it('draws the sentence and leads to the catalog', async () => {
    const { HomeCarousel } = await import('./components/HomeBlocks');
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <I18nProvider lang="uz" setLang={() => undefined}>
            <HomeCarousel firstOrderFree={false} freeFromUzs={null} banners={[{ id: 'b3', kind: 'ai', image_url: null, image_jpeg_url: null, link: null }]} />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const link = screen.getByRole('link', { name: /Savatda oʻz toʻplamingizni yigʻing/ });
    expect(link.getAttribute('href')).toBe('/catalog');
  });
});
