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
  subtitle: { ru: '3 правила врачебного отбора', uz: 'Shifokor tanlovining 3 qoidasi' },
  intro: { ru: 'Вступление', uz: 'Kirish' },
  points: [1, 2, 3].map((n) => ({ title: { ru: `Пункт ${n}`, uz: `Band ${n}` }, text: { ru: `Текст ${n}`, uz: `Matn ${n}` } })),
  outro: { ru: 'Заключение', uz: 'Xulosa' },
};

const OUT: ProductListItem = {
  id: 'p2', sku: 'OZN-A020', name_ru: 'Магний Цитрат + B6', name_uz: null, short_name_ru: 'Магний Цитрат + B6, 120 таб.', short_name_uz: null,
  brand: 'VitaMeal', price_uzs: 98000, old_price_uzs: null, image_url: null, in_stock: false,
} as ProductListItem;

let manifest: Manifest;
let waiting: string[];
let puts: string[];
let events: string[];
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('scrollTo', () => undefined);
  tg.on = false;
  tg.opened = [];
  manifest = MANIFEST;
  waiting = [];
  puts = [];
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
  it('an out-of-stock card has an active bell instead of a grey [+]; one tap subscribes once', async () => {
    show('ru', <ProductTile product={OUT} />);
    const bell = await screen.findByRole('button', { name: 'Сообщить о поступлении' });
    expect(bell).toHaveProperty('disabled', false);
    fireEvent.click(bell);
    expect(await screen.findByText('Сообщим, когда товар появится')).toBeTruthy();
    const on = await screen.findByRole('button', { name: 'Вы в списке ожидания' });
    expect(on.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(on); // already waiting: no second request, only the reminder
    expect(await screen.findByText('Вы в списке ожидания')).toBeTruthy();
    expect(puts).toEqual(['p2']);
  });

  it('a customer already on the list sees «Kutish roʻyxatidasiz» in Uzbek right away', async () => {
    waiting = ['p2'];
    show('uz', <ProductTile product={OUT} />);
    expect(await screen.findByRole('button', { name: 'Siz kutish roʻyxatidasiz' })).toBeTruthy();
  });
});

describe('2.4: manifest «Как VITALO отбирает добавки»', () => {
  it('the Home entry opens the sheet: intro, 3 numbered points, outro and «Спросить специалиста»', async () => {
    show('ru', <ManifestEntry />);
    fireEvent.click(await screen.findByRole('button', { name: /Как VITALO отбирает добавки/ }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Вступление')).toBeTruthy();
    expect(within(sheet).getAllByRole('listitem')).toHaveLength(3);
    expect(within(sheet).getByText('Заключение')).toBeTruthy();
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

describe('2.4: «Подбор» in the bottom menu', () => {
  it('5 items with the centre «Подбор»; it opens «Скоро…» with «Спросить специалиста» and the manifest', async () => {
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
    expect(within(nav).getAllByText(/^(Главная|Каталог|Подбор|Избранное|Профиль)$/).map((x) => x.textContent)).toEqual(['Главная', 'Каталог', 'Подбор', 'Избранное', 'Профиль']);
    fireEvent.click(within(nav).getByRole('button', { name: 'Подбор' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Скоро здесь будет умный подбор витаминов')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Спросить специалиста' })).toBeTruthy();
    await vi.waitFor(() => expect(events).toContain('ai_tab_click'));
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Как VITALO отбирает добавки' }));
    expect(await screen.findByText('Вступление')).toBeTruthy();
  });
});

describe('2.4: «Спросить специалиста»', () => {
  it('in Telegram: the text is copied and the hint shown first, the chat with ?text= opens a moment later', async () => {
    tg.on = true;
    show('ru', <ManifestEntry />);
    fireEvent.click(await screen.findByRole('button', { name: /Как VITALO/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Спросить специалиста' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Здравствуйте! Помогите, пожалуйста, подобрать витамины…');
    expect(await screen.findByText('Текст скопирован — если его нет в чате, вставьте')).toBeTruthy();
    expect(tg.opened).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(ASK_OPEN_DELAY_MS + 10));
    expect(tg.opened).toHaveLength(1);
    expect(tg.opened[0]).toMatch(/^https:\/\/t\.me\/VITALO_support\?text=/);
    expect(decodeURIComponent(tg.opened[0].split('text=')[1])).toBe('Здравствуйте! Помогите, пожалуйста, подобрать витамины…');
  });

  it('in a browser the chat opens at once (a delayed window.open would be blocked)', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    show('uz', <ManifestEntry />);
    fireEvent.click(await screen.findByRole('button', { name: /VITALO qoʻshimchalarni/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mutaxassisdan soʻrash' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0][0])).toContain('text=');
  });
});
