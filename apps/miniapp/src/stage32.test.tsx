import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveOrderBar, IntakeGuideBlock } from './components/OrderNotices';
import { SheetsProvider } from './components/Sheets';
import { ToastProvider } from './components/Toast';
import { I18nProvider } from './lib/i18n';
import type { ActiveOrder, CentreItem, CentreList, IntakeGuide, Lang } from './lib/types';
import { Notifications } from './screens/Notifications';

vi.mock('./lib/telegram', async (orig) => {
  const real = await orig<typeof import('./lib/telegram')>();
  return { ...real, telegram: () => null };
});

let active: ActiveOrder;
let centre: CentreList;
let events: { event: string; props?: Record<string, unknown> }[];
let posts: string[];
beforeEach(() => {
  vi.stubGlobal('scrollTo', () => undefined);
  events = [];
  posts = [];
  active = { order: null, more: 0 };
  centre = { unread: 0, tabs: { orders: 0, promo: 0, service: 0 }, items: [] };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const json = (b: unknown) => new Response(JSON.stringify(b));
    if (url.includes('/analytics/events')) {
      events.push(JSON.parse(init.body as string));
      return json({ accepted: true });
    }
    if (init.method === 'POST') posts.push(url);
    if (url.includes('/orders/active')) return json(active);
    if (url.includes('/notifications/read-all')) return json({ marked: centre.unread, unread: 0, tabs: { orders: 0, promo: 0, service: 0 } });
    if (url.match(/\/notifications\/[^/]+\/read/)) return json({ unread: Math.max(0, centre.unread - 1), tabs: centre.tabs });
    if (url.includes('/notifications')) return json(centre);
    if (url.includes('/catalog/texts')) return json({ support_url: 'https://t.me/VITALO_support', delivery_days_label: { ru: 'рабочих дней', uz: 'ish kuni' } });
    return json([]);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}
function show(lang: Lang, ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider lang={lang} setLang={() => undefined}>
          <ToastProvider>
            <SheetsProvider>
              <Routes>
                <Route path="/" element={ui} />
                <Route path="*" element={<Where />} />
              </Routes>
            </SheetsProvider>
          </ToastProvider>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const order = (o: Partial<NonNullable<ActiveOrder['order']>> = {}): NonNullable<ActiveOrder['order']> => ({
  id: 'o1',
  order_number: 'VTL-20261101-0001',
  status: 'awaiting_payment',
  payment_method: 'card_transfer',
  payment_reported: false,
  can_pay: true,
  delivery_eta: { min_days: 1, max_days: 3, note_ru: null, note_uz: null },
  ...o,
});

describe('3.2 active order plaque', () => {
  it('number · status · term, «Подробнее», «+N» and «Оплатить / Отправить чек»; taps are reported', async () => {
    active = { order: order(), more: 2 };
    show('ru', <ActiveOrderBar />);
    expect(await screen.findByText('Заказ №VTL-20261101-0001')).toBeTruthy();
    expect(screen.getByText('+2')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Ожидает оплаты · доставка 1–3 рабочих дней/)).toBeTruthy());
    fireEvent.click(screen.getByText('Оплатить / Отправить чек'));
    expect(screen.getByTestId('where').textContent).toBe('/orders/o1/pay');
    await waitFor(() => expect(events).toContainEqual({ event: 'active_order_click', props: { order_id: 'o1', action: 'pay' } }));
  });

  it('cash on delivery: «Ожидает подтверждения», no pay button; Uzbek', async () => {
    active = { order: order({ status: 'new', payment_method: 'cod', can_pay: false }), more: 0 };
    show('uz', <ActiveOrderBar />);
    expect(await screen.findByText('№VTL-20261101-0001 buyurtma')).toBeTruthy();
    expect(screen.getByText(/Tasdiqlash kutilmoqda/)).toBeTruthy();
    expect(screen.queryByText('To‘lash / Chek yuborish')).toBeNull();
    expect(screen.queryByText(/^\+/)).toBeNull();
  });

  it('nothing without an unfinished order', async () => {
    const { container } = show('ru', <ActiveOrderBar />);
    await waitFor(() => expect(posts).toEqual([]));
    expect(container.querySelector('.active-order')).toBeNull();
  });
});

describe('3.2 notification centre', () => {
  const card = (c: Partial<CentreItem>): CentreItem => ({
    id: 'n1', tab: 'orders', category: 'order', template: 'order.paid', title: 'Заказ №VTL-1', body: 'Оплата подтверждена',
    steps: [], has_guide: false, path: '/orders/o1', read: true, created_at: '2026-11-01T10:00:00Z', ...c,
  });

  it('opens on the first tab with unread; one order card with its steps and the memo note; a tap marks it read and opens the order', async () => {
    centre = {
      unread: 1,
      tabs: { orders: 1, promo: 0, service: 0 },
      items: [
        card({ id: 'n2', read: false, steps: ['Принят', 'Оплачен'], has_guide: true }),
        card({ id: 'n1', tab: 'service', category: 'waitlist', template: 'waitlist.back_in_stock', title: 'Омега-3', body: 'Снова в наличии', path: '/product/p1', created_at: '2026-10-31T10:00:00Z' }),
      ],
    };
    const { container } = show('ru', <Notifications />);
    expect(await screen.findByText('Оплата подтверждена')).toBeTruthy();
    expect([...container.querySelectorAll('[role=tab]')].map((e) => e.textContent)).toEqual(['Заказы1', 'Акции и бонусы', 'Сервисные']);
    expect(screen.getByRole('tab', { name: /Заказы/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Принят → Оплачен')).toBeTruthy();
    expect(screen.getByText('Памятка по приёму — в заказе')).toBeTruthy();
    expect(screen.queryByText('Омега-3')).toBeNull();
    expect(container.querySelectorAll('.centre-item.is-unread')).toHaveLength(1);

    fireEvent.click(screen.getByText('Оплата подтверждена'));
    expect(screen.getByTestId('where').textContent).toBe('/orders/o1');
    await waitFor(() => expect(posts.some((u) => u.includes('/notifications/n2/read'))).toBe(true));
    await waitFor(() => expect(events).toContainEqual({ event: 'notification_open', props: { category: 'order', template: 'order.paid', tab: 'orders' } }));
  });

  it('switching tabs; an empty tab says so', async () => {
    centre = { unread: 0, tabs: { orders: 0, promo: 0, service: 0 }, items: [card({ tab: 'service', category: 'waitlist', template: 'waitlist.back_in_stock', title: 'Омега-3', body: 'Снова в наличии' })] };
    show('uz', <Notifications />);
    expect(await screen.findByText('Bu yerda hozircha bo‘sh')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Xizmat' }));
    expect(screen.getByText('Омега-3')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Aksiya va bonuslar' }));
    expect(screen.getByText('Bu yerda hozircha bo‘sh')).toBeTruthy();
  });

  it('«Прочитать все» only with unread ones; reports notification_read_all', async () => {
    centre = { unread: 3, tabs: { orders: 0, promo: 3, service: 0 }, items: [card({ tab: 'promo', category: 'promo', template: 'promo.message', title: 'Акция', body: '−15%', path: null, read: false })] };
    show('uz', <Notifications />);
    expect(await screen.findByText('−15%')).toBeTruthy();
    fireEvent.click(screen.getByText('Hammasini o‘qish'));
    await waitFor(() => expect(posts.some((u) => u.includes('/notifications/read-all'))).toBe(true));
    await waitFor(() => expect(events).toContainEqual({ event: 'notification_read_all', props: { count: 3 } }));
  });

  it('empty centre', async () => {
    show('ru', <Notifications />);
    expect(await screen.findByText('Уведомлений пока нет')).toBeTruthy();
    expect(screen.queryByText('Прочитать все')).toBeNull();
  });
});

describe('3.2 intake memo in the order card', () => {
  const guide: IntakeGuide = {
    ru: [{ product_id: 'p1', name: 'Магний B6', text: 'По 2 таблетки во время еды' }],
    uz: [],
    footer: { ru: 'Сверяйте с этикеткой. Если принимаете лекарства — уточните у специалиста.', uz: 'Yorliq bilan solishtiring.' },
  };
  it('folded block with the memos, the footer and «Спросить специалиста»; Uzbek falls back to Russian memos', () => {
    show('uz', <IntakeGuideBlock guide={guide} orderNumber="VTL-1" />);
    expect(screen.getByText('Qanday qabul qilish kerak')).toBeTruthy();
    expect(screen.getByText('По 2 таблетки во время еды')).toBeTruthy();
    expect(screen.getByText('Yorliq bilan solishtiring.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Mutaxassisdan|Спросить|so/ })).toBeTruthy();
  });
});
