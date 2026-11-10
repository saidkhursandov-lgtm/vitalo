import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Layout } from './components/Layout';
import { ManifestEntry, SheetsProvider } from './components/Sheets';
import { ASK_OPEN_DELAY_MS } from './components/Support';
import { ToastProvider } from './components/Toast';
import { ProductTile } from './components/ui';
import { I18nProvider } from './lib/i18n';
import { resetQuickCart } from './lib/quick-cart';
import type { Lang, Manifest, ProductListItem } from './lib/types';

// Telegram is reached only through the adapter; here it is switched on and off per test.
const tg = vi.hoisted(() => ({ on: false, opened: [] as string[] }));
vi.mock('./lib/telegram', async (orig) => {
  const real = await orig<typeof import('./lib/telegram')>();
  return { ...real, telegram: () => (tg.on ? { openTelegramLink: (u: string) => tg.opened.push(u), BackButton: undefined } : null) };
});

const MANIFEST: Manifest = {
  enabled: true,
  title: { ru: 'Как VITALO отбирает добавки', uz: 'VITALO qoʻshimchalarni qanday tanlaydi' },
  subtitle: { ru: '3 критерия отбора', uz: '3 ta tanlov mezoni' },
  lead: { ru: 'Вступление', uz: 'Kirish' },
  cards: [1, 2, 3].map((n) => ({
    title: { ru: `Карточка ${n}`, uz: `Karta ${n}` },
    // the owner may leave «Не берём» empty: then the line is not shown
    bad: n === 2 ? { ru: '', uz: '' } : { ru: `Не берём ${n}`, uz: `Olmaymiz ${n}` },
    good: { ru: `Берём ${n}`, uz: `Olamiz ${n}` },
  })),
};

const OUT: ProductListItem = {
  id: 'p2', sku: 'OZN-A020', name_ru: 'Магний Цитрат + B6', name_uz: null, short_name_ru: 'Магний Цитрат + B6, 120 таб.', short_name_uz: null,
  brand: 'VitaMeal', price_uzs: 98000, old_price_uzs: null, image_url: null, in_stock: false,
} as ProductListItem;

let manifest: Manifest;
let waiting: string[];
let puts: string[];
let deletes: string[];
let events: string[];
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('scrollTo', () => undefined);
  tg.on = false;
  tg.opened = [];
  manifest = MANIFEST;
  waiting = [];
  puts = [];
  deletes = [];
  events = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const json = (b: unknown) => new Response(JSON.stringify(b));
    if (url.includes('/analytics/events')) {
      events.push(JSON.parse(init.body as string).event);
      return json({ accepted: true });
    }
    if (url.includes('/waitlist/ids')) return json(waiting);
    if (method === 'PUT' && url.includes('/waitlist/')) {
      const id = url.split('/waitlist/')[1];
      puts.push(id);
      waiting.push(id);
      return json({ status: 'subscribed' });
    }
    if (method === 'DELETE' && url.includes('/waitlist/')) {
      const id = url.split('/waitlist/')[1];
      deletes.push(id);
      waiting = waiting.filter((x) => x !== id);
      return json({ status: 'cancelled' });
    }
    if (url.endsWith('/cart/count')) return json({ items_count: 0, goods_total_uzs: 0 });
    if (url.includes('/catalog/texts')) return json({ support_url: 'https://t.me/VITALO_support', manifest });
    return json([]);
  });
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});
afterEach(() => {
  resetQuickCart();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function show(lang: Lang, ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <ToastProvider>
            <SheetsProvider>
              <Routes>
                <Route path="/" element={ui} />
              </Routes>
            </SheetsProvider>
          </ToastProvider>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('2.4: waiting list «Сообщить о поступлении»', () => {
  it('the bell is a switch: a tap subscribes, a tap on the active bell switches it off', async () => {
    show('ru', <ProductTile product={OUT} />);
    const bell = await screen.findByRole('button', { name: 'Сообщить о поступлении' });
    expect(bell).toHaveProperty('disabled', false);
    fireEvent.click(bell);
    expect(await screen.findByText('Сообщим в Telegram, когда появится')).toBeTruthy();
    const on = await screen.findByRole('button', { name: 'Отменить уведомление' });
    expect(on.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(on);
    expect(await screen.findByText('Уведомление отключено')).toBeTruthy();
    expect((await screen.findByRole('button', { name: 'Сообщить о поступлении' })).getAttribute('aria-pressed')).toBe('false');
    expect(puts).toEqual(['p2']);
    expect(deletes).toEqual(['p2']);
  });

  it('«Отменить» in the toast switches the notification off', async () => {
    show('ru', <ProductTile product={OUT} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Сообщить о поступлении' }));
    const toast = await screen.findByRole('status');
    fireEvent.click(await within(toast).findByRole('button', { name: 'Отменить' }));
    expect(await screen.findByText('Уведомление отключено')).toBeTruthy();
    expect(deletes).toEqual(['p2']);
  });

  it('a customer already on the list sees the active bell in Uzbek right away', async () => {
    waiting = ['p2'];
    show('uz', <ProductTile product={OUT} />);
    expect(await screen.findByRole('button', { name: 'Bildirishnomani bekor qilish' })).toBeTruthy();
  });
});

describe('2.4: manifest «Как VITALO отбирает добавки»', () => {
  it('the Home entry opens the sheet: the lead, 3 cards «Не берём / Стандарт VITALO» and «Спросить специалиста»', async () => {
    show('ru', <ManifestEntry />);
    fireEvent.click(await screen.findByRole('button', { name: /Как VITALO отбирает добавки/ }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Вступление')).toBeTruthy();
    expect(within(sheet).getAllByRole('listitem')).toHaveLength(3);
    expect(within(sheet).getByText('Не берём 1')).toBeTruthy();
    expect(within(sheet).getByText('Берём 2')).toBeTruthy();
    expect(sheet.querySelectorAll('.manifest-line.is-bad')).toHaveLength(2); // card 2 has an empty «Не берём»
    expect(sheet.querySelectorAll('.manifest-line.is-good')).toHaveLength(3);
    expect(within(sheet).getByRole('button', { name: 'Спросить специалиста' })).toBeTruthy();
    await vi.waitFor(() => expect(events).toContain('manifest_open'));
  });

  it('is hidden when switched off in the admin panel', async () => {
    manifest = { ...MANIFEST, enabled: false };
    show('ru', <ManifestEntry />);
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(screen.queryByRole('button', { name: /Как VITALO/ })).toBeNull();
  });
});

describe('2.4: the centre «VITALO AI» (3.8, was «AI-подбор»)', () => {
  it('5 items with the centre «VITALO AI»; it opens the preview with locked chips, «Спросить специалиста» and the manifest', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <I18nProvider lang="ru" setLang={() => undefined}>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<p>Главная</p>} />
              </Route>
            </Routes>
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const nav = await screen.findByRole('navigation');
    expect(within(nav).getAllByText(/^(Главная|Каталог|VITALO AI|Избранное|Профиль)$/).map((x) => x.textContent)).toEqual(['Главная', 'Каталог', 'VITALO AI', 'Избранное', 'Профиль']);
    fireEvent.click(within(nav).getByRole('button', { name: 'VITALO AI' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Персональный AI-подбор курса витаминов')).toBeTruthy();
    expect(within(sheet).getByText('VITALO AI • по правилам отбора VITALO')).toBeTruthy();
    const chips = within(sheet).getAllByRole('button', { name: /Скоро/ });
    expect(chips).toHaveLength(3);
    fireEvent.click(chips[0]); // does nothing: no navigation, no request, the sheet stays
    expect(chips[0].getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('dialog')).toBe(sheet);
    expect(sheet.textContent).not.toMatch(/врач|медицинск/i);
    expect(within(sheet).getByRole('button', { name: 'Спросить специалиста' })).toBeTruthy();
    await vi.waitFor(() => expect(events).toContain('ai_tab_click'));
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Как VITALO отбирает добавки' }));
    expect(await screen.findByText('Вступление')).toBeTruthy();
  });
});

describe('2.4 / 6а-Д: «Спросить специалиста»', () => {
  it('opens the in-app sheet with the topic row (6б-Б) — no jump to the Telegram chat', async () => {
    tg.on = true;
    show('ru', <ManifestEntry />);
    fireEvent.click(await screen.findByRole('button', { name: /Как VITALO/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Спросить специалиста' }));
    const sheet = await screen.findByRole('dialog', { name: 'Спросить специалиста' });
    expect(within(sheet).getByRole('button', { name: /Тема вопроса/ }).textContent).toContain('Медицинский вопрос / Подбор');
    await act(() => vi.advanceTimersByTimeAsync(ASK_OPEN_DELAY_MS + 10));
    expect(tg.opened).toEqual([]);
  });
});
