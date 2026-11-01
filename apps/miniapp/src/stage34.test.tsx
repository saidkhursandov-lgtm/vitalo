import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompatBlock, setKeyOf } from './components/Compat';
import { I18nProvider, translate } from './lib/i18n';
import type { CompatRequest, CompatState, Lang } from './lib/types';

const answered = (over: Partial<CompatRequest> = {}): CompatRequest => ({
  id: 'r1',
  status: 'answered',
  source: 'specialist',
  verdict: 'spread',
  text: 'Магний — вечером, железо — утром.',
  created_at: '2026-11-01T10:00:00Z',
  answered_at: '2026-11-01T10:20:00Z',
  changed: false,
  products: ['Магний B6', 'Железо'],
  ...over,
});
const base: CompatState = { eligible: true, products: ['Магний B6', 'Железо'], left_today: 5, request: null };

let events: { event: string; props?: Record<string, unknown> }[];
let posted: unknown[];

/** The API answers GET /compat with `state` and POST /compat with `post` (or an error). */
function mock(state: CompatState, post?: { status: number; body: object }) {
  events = [];
  posted = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url.includes('/analytics/events')) {
      events.push(JSON.parse(init.body as string));
      return new Response('{}', { status: 202 });
    }
    if (url.includes('/compat') && init.method === 'POST') {
      posted.push(JSON.parse((init.body as string) ?? '{}'));
      return new Response(JSON.stringify(post?.body ?? {}), { status: post?.status ?? 200 });
    }
    return new Response(JSON.stringify(state));
  });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(lang: Lang = 'ru', ids = ['a', 'b']) {
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

describe('3.4 «Проверить совместимость у специалиста»', () => {
  it('the set key ignores order and repeats', () => {
    expect(setKeyOf(['b', 'a', 'b'])).toBe(setKeyOf(['a', 'b']));
  });

  it('nothing with fewer than 2 different products', async () => {
    mock({ ...base, eligible: false });
    const { container } = show();
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('the widget opens the sheet: the cart, an optional comment, the disclaimer; sending shows «Запрос отправлен специалисту»', async () => {
    mock(base, { status: 200, body: { ...base, result: 'sent', left_today: 4, request: answered({ status: 'pending', verdict: null, text: null }) } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Проверить совместимость у специалиста/ }));
    expect(screen.getByText('Ответим в рабочее время 8:00–22:00', { selector: '.ask-text span' })).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Магний B6');
    expect(dialog.textContent).toContain('Не является медицинской консультацией');
    fireEvent.change(screen.getByLabelText('Комментарий (например, принимаете ли лекарства)'), { target: { value: '  Принимаю аспирин ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await screen.findByText('Запрос отправлен специалисту');
    expect(posted).toEqual([{ comment: 'Принимаю аспирин' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Понятно' }));
    await screen.findByText('Запрос отправлен специалисту — ждём ответа');
    expect(screen.queryByRole('button', { name: /Проверить совместимость/ })).toBeNull();
  });

  it('the daily limit is explained', async () => {
    mock(base, { status: 429, body: { code: 'DAILY_LIMIT' } });
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Проверить совместимость/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Сегодня можно отправить не больше 5 запросов. Попробуйте завтра.');
    expect(posted).toEqual([{}]); // an empty comment is not sent
  });

  it('the answer card: coloured label, text, disclaimer; counted once as compat_view', async () => {
    mock({ ...base, request: answered() });
    show();
    const label = await screen.findByText('Разнести по времени');
    expect(label.className).toContain('is-spread');
    expect(screen.getByText('Магний — вечером, железо — утром.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Проверить совместимость/ })).toBeNull();
    await waitFor(() => expect(events).toEqual([{ event: 'compat_view', props: { verdict: 'spread', source: 'specialist', changed: false } }]));
  });

  it('a saved answer is marked «Ответ специалиста VITALO для этого сочетания»; UZ texts', async () => {
    mock({ ...base, request: answered({ source: 'instant', verdict: 'compatible' }) });
    show('uz');
    expect((await screen.findByText('Mos keladi')).className).toContain('is-compatible');
    expect(screen.getByText('Ushbu birikma uchun VITALO mutaxassisi javobi')).toBeTruthy();
    expect(screen.getByText('Tibbiy maslahat hisoblanmaydi')).toBeTruthy();
  });

  it('the cart changed after the answer: «Состав корзины изменился — проверьте снова» and the button again', async () => {
    mock({ ...base, request: answered({ verdict: 'consult', changed: true }) });
    show();
    expect((await screen.findByText('Нужна консультация специалиста')).className).toContain('is-consult');
    expect(screen.getByText(/Состав корзины изменился — проверьте снова/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Проверить совместимость у специалиста/ })).toBeTruthy();
  });

  it('UZ widget title fits the owner’s wording', () => {
    expect(translate('uz', 'compat.title')).toBe('Moslikni mutaxassisda tekshirish');
  });
});
