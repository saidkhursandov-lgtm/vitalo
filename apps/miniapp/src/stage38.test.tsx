import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_CACHED_MS, AI_MIN_MS, aiBadge } from './components/AiCompat';
import { CompatBlock } from './components/Compat';
import { I18nProvider } from './lib/i18n';
import type { AiAnswer, AiState, CompatState, Lang } from './lib/types';

const compat = (over: Partial<CompatState> = {}): CompatState => ({ eligible: true, products: ['Магний B6', 'Витамин D3'], left_today: 5, request: null, ...over });
const ai = (over: Partial<AiState> = {}): AiState => ({ available: true, consent: true, eligible: true, left_today: 1, cached: false, answer: null, ...over });
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
  reasons: { synergy: false, spread: true, avoid: false, overlap: true },
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
  // D-70: the checked set and «Скрыть» are remembered — every test starts clean
  sessionStorage.clear();
  localStorage.clear();
  AI_MIN_MS.value = 0;
  AI_CACHED_MS.value = 0;
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
  it('one block: the title, the subtitle and no specialist button or pale hint beside it', async () => {
    mock(compat(), ai());
    show();
    const main = await screen.findByRole('button', { name: /Сверить совместимость \d+ товаров с VITALO AI/ });
    expect(main.textContent).toContain('Проверить совместимость');
    expect(screen.getByText('Разбор совместимости и схема приёма за несколько секунд')).toBeTruthy();
    // the products of the cart are listed right under the block — no thumbnails inside it
    expect(document.querySelector('.ai-hero img, .ai-hero .ai-thumbs')).toBeNull();
    // D-70: the second button — «Спросить VITALO AI о корзине»
    expect(screen.getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Проверить совместимость', 'Спросить VITALO AI о корзине']);
    expect(screen.queryByText(/у специалиста|специалиста лично/)).toBeNull();
  });

  it('one product: «С чем сочетать этот препарат?», no specialist button', async () => {
    mock(compat({ eligible: false, products: ['Магний B6'] }), ai());
    show('ru', ['p1']);
    expect(await screen.findByRole('button', { name: /С чем сочетать этот препарат\?/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /специалиста/ })).toBeNull();
  });

  it('no key or switched off: the block leads to the specialist, as in 3.4', async () => {
    mock(compat(), ai({ available: false }));
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Спросить специалиста лично/ }));
    expect(screen.getByRole('dialog', { name: 'Проверить совместимость у специалиста' })).toBeTruthy();
    expect(screen.queryByText(/VITALO AI/)).toBeNull();
  });

  it('the consent closed without «Я согласен»: the block leads to the specialist, VITALO AI can be asked again', async () => {
    sessionStorage.clear();
    mock(compat(), ai({ consent: false }));
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Сверить совместимость \d+ товаров с VITALO AI/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Перед началом' })).getByRole('button', { name: 'Закрыть' }));
    expect(await screen.findByRole('button', { name: /Спросить специалиста лично/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Сверить совместимость \d+ товаров с VITALO AI/ })).toBeNull();
    expect(posts('/compat/ai/check')).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /Проверить с VITALO AI/ }));
    expect(screen.getByRole('dialog', { name: 'Перед началом' })).toBeTruthy();
    sessionStorage.clear();
  });

  it('first time: the consent, then the check; the card: navy title, badge, times, medicine lines', async () => {
    mock(compat(), ai({ consent: false }), { check: { status: 200, body: ai({ result: 'ai', left_today: 0, answer: answer() }) } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Сверить совместимость \d+ товаров с VITALO AI/ }));
    const dialog = screen.getByRole('dialog', { name: 'Перед началом' });
    expect(dialog.textContent).toContain('не ставит диагнозы и не заменяет консультацию врача');
    expect(dialog.textContent).toContain('Нажимая «Я согласен», вы принимаете Правила использования VITALO AI и Политику конфиденциальности.');
    expect(within(dialog).getByRole('link', { name: 'Политику конфиденциальности' }).getAttribute('href')).toBe('/legal/privacy');
    expect(posts('/compat/ai/check')).toBe(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Я согласен' }));

    const card = await screen.findByRole('region', { name: 'Разбор совместимости VITALO AI' });
    expect(posts('/compat/ai/consent')).toBe(1);
    expect(posts('/compat/ai/check')).toBe(1);
    expect(card.querySelector('.ai-verdict')!.textContent).toBe('Разнести по времени');
    expect(card.querySelector('.ai-verdict')!.className).toContain('is-yellow');
    expect(card.textContent).toContain('Утро, с едой');
    expect(card.querySelectorAll('.ai-timing svg')).toHaveLength(2);
    expect(card.textContent).toContain('минимум на 4 часа');
    expect(card.textContent).toContain('Если принимаете лекарства — уточните у врача');
    expect(card.textContent).toContain('Не является медицинской консультацией');
    expect(screen.queryByRole('button', { name: /Сверить совместимость \d+ товаров с VITALO AI/ })).toBeNull();
    // «Спросить специалиста лично» inside the answer opens the 3.4 sheet
    fireEvent.click(within(card).getByRole('button', { name: 'Спросить специалиста лично' }));
    expect(screen.getByRole('dialog', { name: 'Проверить совместимость у специалиста' })).toBeTruthy();
    await waitFor(() => expect(events.map((e) => e.event)).toContain('compat_view'));
    expect(events.find((e) => e.event === 'compat_view')!.props).toMatchObject({ source: 'ai', verdict: 'spread' });
  });

  it('a repeated substance is named once, by the app, in one short line', async () => {
    mock(compat(), ai({ cached: true, answer: answer() }), { check: { status: 200, body: ai({ result: 'ai_cache', cached: true, answer: answer() }) } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^(?!Спросить |VITALO AI dan ).*VITALO AI/s }));
    const card = await screen.findByRole('region', { name: 'Разбор совместимости VITALO AI' });
    expect(card.querySelectorAll('.ai-overlap')).toHaveLength(1);
    expect(card.querySelector('.ai-overlap')!.textContent!.trim()).toBe('Повтор: Витамин B6 — проверьте суммарную дозировку');
    expect(card.textContent!.match(/суммарн/g)).toHaveLength(1);
    expect(card.textContent).not.toContain('Одно вещество есть в нескольких товарах');
  });

  it('badges by reason: synergy, no conflicts, spread, dose only, consult', async () => {
    const no = { synergy: false, spread: false, avoid: false, overlap: false };
    expect(aiBadge({ verdict: 'compatible', reasons: { ...no, synergy: true } })).toEqual({ tone: 'green', key: 'ai.b.synergy' });
    expect(aiBadge({ verdict: 'compatible', reasons: no })).toEqual({ tone: 'green', key: 'ai.b.none' });
    expect(aiBadge({ verdict: 'spread', reasons: { ...no, spread: true, overlap: true } })).toEqual({ tone: 'yellow', key: 'ai.b.spread' });
    expect(aiBadge({ verdict: 'spread', reasons: { ...no, overlap: true } })).toEqual({ tone: 'yellow', key: 'ai.b.dose' });
    expect(aiBadge({ verdict: 'consult', reasons: { ...no, avoid: true } })).toEqual({ tone: 'red', key: 'ai.b.consult' });
    const dose = ai({ result: 'ai_cache', cached: true, answer: answer({ reasons: { ...no, overlap: true } }) });
    mock(compat(), dose, { check: { status: 200, body: dose } });
    show('uz');
    fireEvent.click(await screen.findByRole('button', { name: /^(?!Спросить |VITALO AI dan ).*VITALO AI/s }));
    const card = await screen.findByRole('region', { name: 'VITALO AI moslik tahlili' });
    expect(card.querySelector('.ai-verdict')!.textContent).toBe('Dozani tekshiring');
  });

  it('the 4 steps are ticked in turn while the answer is coming', async () => {
    AI_MIN_MS.value = 400;
    mock(compat(), ai(), { check: { status: 200, body: ai({ result: 'ai', answer: answer({ overlaps: [], overlap_text: null, drugs: [] }) }) } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^(?!Спросить |VITALO AI dan ).*VITALO AI/s }));
    expect(await screen.findByText('Сверяю 2 товара…')).toBeTruthy();
    for (const step of ['Сверяем вещества и формы в товарах…', 'Ищем повторы веществ в разных товарах…', 'Проверяем правила сочетаний VITALO…', 'Составляем режим приёма: утро / вечер…']) {
      expect(screen.getByText(step)).toBeTruthy();
    }
    await waitFor(() => expect(document.querySelectorAll('.ai-steps .is-done').length).toBeGreaterThan(0));
    const card = await screen.findByRole('region', { name: 'Разбор совместимости VITALO AI' });
    expect(card.textContent).not.toContain('суммарную дозировку');
  });

  it('one product: suggestions in stock are links to the product', async () => {
    const one = ai({ result: 'ai', answer: answer({ verdict: 'compatible', timing: [], overlaps: [], overlap_text: null, suggestions: [{ product_id: 'p9', name: 'Витамин D3 2000' }] }) });
    mock(compat({ eligible: false, products: ['Магний B6'] }), ai(), { check: { status: 200, body: one } });
    show('ru', ['p1']);
    fireEvent.click(await screen.findByRole('button', { name: /С чем сочетать/ }));
    const link = await screen.findByRole('link', { name: /Витамин D3 2000/ });
    expect(link.getAttribute('href')).toBe('/product/p9');
    expect(screen.queryByRole('button', { name: /специалиста/ })).toBeNull();
  });

  it('the daily limit is known before: the message and the specialist at once, no animation, no request', async () => {
    AI_MIN_MS.value = 5000;
    mock(compat(), ai({ left_today: 0 }), { check: { status: 429, body: { code: 'AI_DAILY_LIMIT' } } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^(?!Спросить |VITALO AI dan ).*VITALO AI/s }));
    expect(screen.getByText(/Бесплатная AI-проверка доступна 1 раз в день/)).toBeTruthy();
    expect(screen.queryByText('Сверяю 2 товара…')).toBeNull();
    expect(posts('/compat/ai/check')).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Спросить специалиста лично' }));
    expect(screen.getByRole('dialog', { name: 'Проверить совместимость у специалиста' })).toBeTruthy();
  });

  it('the limit is spent but the answer is ready (saved or cached): the check goes, the animation is short', async () => {
    AI_MIN_MS.value = 5000;
    mock(compat(), ai({ left_today: 0, cached: true }), { check: { status: 200, body: ai({ result: 'ai_cache', left_today: 0, cached: true, answer: answer() }) } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^(?!Спросить |VITALO AI dan ).*VITALO AI/s }));
    expect(await screen.findByRole('region', { name: 'Разбор совместимости VITALO AI' })).toBeTruthy();
    expect(posts('/compat/ai/check')).toBe(1);
  });

  it('an error: the message and «Спросить специалиста лично»', async () => {
    mock(compat(), ai(), { check: { status: 500, body: { code: 'X' } } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^(?!Спросить |VITALO AI dan ).*VITALO AI/s }));
    expect(await screen.findByText(/Не удалось проверить/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Спросить специалиста лично' })).toBeTruthy();
  });

  it('the AI could not answer: «Ответ готовит специалист VITALO — пришлём в бот»', async () => {
    mock(compat(), ai(), { check: { status: 200, body: ai({ result: 'specialist', reason: 'invalid' }) } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^(?!Спросить |VITALO AI dan ).*VITALO AI/s }));
    expect(await screen.findByText('Ответ готовит специалист VITALO — пришлём в бот')).toBeTruthy();
  });

  it('Uzbek: the button, the consent and «Roziman» fit the texts of the spec', async () => {
    mock(compat(), ai({ consent: false }));
    show('uz');
    fireEvent.click(await screen.findByRole('button', { name: /ta mahsulot mosligini VITALO AI bilan tekshirish/ }));
    const dialog = screen.getByRole('dialog', { name: 'Boshlashdan oldin' });
    expect(dialog.textContent).toContain('«Roziman» tugmasini bosish orqali siz VITALO AI dan foydalanish qoidalari va Maxfiylik siyosatini qabul qilasiz.');
    expect(within(dialog).getByRole('button', { name: 'Roziman' })).toBeTruthy();
  });
});

describe('Шаг 0а: VITALO AI first, the result only by the tap, the specialist as a link', () => {
  const spec = { verdict: 'spread' as const, text: 'Магний вечером, D3 утром — так советует специалист.', conflict: false };

  it('an answer is ready for this cart, but the block stays folded until it is tapped', async () => {
    mock(compat(), ai({ cached: true, answer: answer(), specialist: spec }));
    show();
    expect(await screen.findByRole('button', { name: /Сверить совместимость \d+ товаров с VITALO AI/ })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Разбор совместимости VITALO AI' })).toBeNull();
    expect(screen.queryByText(spec.text)).toBeNull();
    expect(screen.queryByText(/Есть ответ специалиста VITALO/)).toBeNull();
    expect(posts('/compat/ai/check')).toBe(0);
  });

  it('under the AI answer: «Есть ответ специалиста VITALO» opens the text without a second badge; «Спросить специалиста лично» stays', async () => {
    mock(compat(), ai(), { check: { status: 200, body: ai({ result: 'ai', answer: answer(), specialist: spec }) } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^(?!Спросить |VITALO AI dan ).*VITALO AI/s }));
    const card = await screen.findByRole('region', { name: 'Разбор совместимости VITALO AI' });
    expect(card.textContent).not.toContain(spec.text);
    fireEvent.click(within(card).getByRole('button', { name: /Есть ответ специалиста VITALO/ }));
    expect(card.textContent).toContain(spec.text);
    expect(card.querySelectorAll('.compat-label')).toHaveLength(0);
    expect(card.querySelectorAll('.ai-verdict')).toHaveLength(1);
    expect(within(card).getByRole('button', { name: 'Спросить специалиста лично' })).toBeTruthy();
    await waitFor(() => expect(events.some((e) => e.event === 'compat_view' && e.props?.source === 'specialist_link')).toBe(true));
  });

  it('the labels differ: only the AI answer, no link to the specialist answer', async () => {
    mock(compat(), ai(), { check: { status: 200, body: ai({ result: 'ai', answer: answer({ verdict: 'consult' }), specialist: { ...spec, conflict: true } }) } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^(?!Спросить |VITALO AI dan ).*VITALO AI/s }));
    const card = await screen.findByRole('region', { name: 'Разбор совместимости VITALO AI' });
    expect(screen.queryByText(/Есть ответ специалиста VITALO/)).toBeNull();
    expect(card.textContent).not.toContain(spec.text);
  });

  it('the AI could not answer and a saved specialist answer was given at once: it is shown by the tap', async () => {
    mock(compat(), ai(), { check: { status: 200, body: ai({ result: 'instant', answer: null, specialist: spec }) } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /^(?!Спросить |VITALO AI dan ).*VITALO AI/s }));
    expect(await screen.findByText(spec.text)).toBeTruthy();
    expect(screen.getByText('Разнести по времени')).toBeTruthy();
  });

  it('a request waits for a specialist: «ждём ответа» goes under the VITALO AI block', async () => {
    const pending = { id: 'r1', status: 'pending' as const, source: 'specialist' as const, verdict: null, text: null, created_at: '', answered_at: null, changed: false, products: [] };
    mock(compat({ request: pending }), ai());
    const { container } = show();
    await screen.findByRole('button', { name: /^(?!Спросить |VITALO AI dan ).*VITALO AI/s });
    const kids = [...container.querySelector('.compat')!.children].map((e) => e.className);
    expect(kids.indexOf('ai-compat')).toBeLessThan(kids.indexOf('compat-pending'));
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
