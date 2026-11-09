import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderTerm } from './components/Delivery';
import { PayMethods, type PayCard } from './components/PayMethods';
import { clock, PayReceiptSheet } from './components/PayReceipt';
import { I18nProvider } from './lib/i18n';
import type { Lang, Order } from './lib/types';

/** 6а-Г (D-62): Payment Flow — one kind of payment card, «Чек VITALO» over the checkout, one «из США» term. */
const tg = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock('./lib/telegram', async (orig) => {
  const real = await orig<typeof import('./lib/telegram')>();
  return { ...real, openLink: (u: string) => tg.opened.push(u) };
});

const CHECKOUT = 'https://test.paycom.uz/receipt';
let order: Order;

beforeEach(() => {
  vi.stubGlobal('scrollTo', () => undefined);
  tg.opened = [];
  const item = (n: number) => ({ product_id: `p${n}`, sku: `S${n}`, name_ru: `Товар ${n}`, name_uz: `Mahsulot ${n}`, short_name_ru: null, short_name_uz: null, qty: n, unit_price_uzs: 50_000, line_total_uzs: 50_000 * n });
  order = {
    id: 'o1',
    order_number: 'VTL-20261109-0003',
    status: 'awaiting_payment',
    payment_status: 'payment_pending',
    reserved_until: new Date(Date.now() + 29 * 60_000 + 41_500).toISOString(),
    items: [item(1), item(2), item(3), item(4)],
    totals: { goods_total_uzs: 500_000, discount_total_uzs: 0, delivery_cost_uzs: 25_000, total_uzs: 525_000 },
    payment: { method: 'payme', status: 'payment_pending', amount_uzs: 525_000, customer_reported_paid_at: null },
    history: [],
  } as unknown as Order;
  vi.stubGlobal('fetch', async (url: string) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.includes('/payments/online/payme/orders/o1/start')) return json({ payment_id: 'p1', checkout_url: CHECKOUT, pay_until: order.reserved_until });
    if (url.endsWith('/orders/o1')) return json(order);
    if (url.includes('/catalog/texts')) return json({ delivery_days_label: { ru: 'рабочих дней', uz: 'ish kuni' } });
    return json([]);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(lang: Lang, ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider lang={lang} setLang={() => undefined}>
          {ui}
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('6а-Г: payment methods are one kind of card', () => {
  const cards: PayCard[] = [
    { code: 'payme', state: 'ok', desc: 'Картой Uzcard или Humo' },
    { code: 'click', state: 'soon', desc: 'Скоро подключим' },
    { code: 'uzum', state: 'soon', desc: 'Скоро подключим' },
    { code: 'card_transfer', state: 'ok', desc: 'Перевод с карты' },
    { code: 'cod', state: 'disabled', desc: 'Доступно для заказов до 1 000 000 сум' },
  ];

  it('every method: a logo box, the name with one line under it; the choice or «Скоро» on the right', () => {
    const onChange = vi.fn();
    const { container } = show('ru', <PayMethods cards={cards} value="card_transfer" onChange={onChange} />);
    const all = [...container.querySelectorAll('.pay-card')];
    expect(all).toHaveLength(5);
    for (const c of all) expect([...c.children].slice(0, 2).map((x) => x.className)).toEqual([expect.stringContaining('pay-card-logo'), 'pay-card-text']);
    expect(all.map((c) => c.querySelector('strong')!.textContent)).toEqual(['Payme', 'Click', 'Uzum', 'Перевод на карту', 'Оплата при получении']);
    expect(all[3].classList.contains('is-on')).toBe(true);
    expect(all[4].classList.contains('is-disabled')).toBe(true);
    expect((all[4].querySelector('input') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(all[0].querySelector('input')!);
    expect(onChange).toHaveBeenCalledWith('payme');
    // «Скоро» is not a choice: a tap explains
    fireEvent.click(screen.getByLabelText('Click · Скоро'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog').textContent).toContain('Оплата через Click скоро заработает');
  });
});

describe('6а-Г: «Чек VITALO» over the checkout', () => {
  it('number, booking timer, short list, total; «Оплатить в Payme» starts the payment at once', async () => {
    const onClose = vi.fn();
    show('ru', <PayReceiptSheet orderId="o1" provider="payme" onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'Чек VITALO' });
    await screen.findByText('VTL‑20261109‑0003');
    expect(screen.getByRole('timer').textContent).toMatch(/^Товары забронированы ещё 29:4\d$/);
    expect(dialog.querySelectorAll('.receipt-items li')).toHaveLength(4); // 3 lines + «и ещё»
    expect(dialog.textContent).toContain('и ещё товаров: 1');
    expect(dialog.querySelector('.receipt-total')!.textContent!.replace(/\s/g, ' ')).toContain('525 000');
    const pay = await screen.findByRole('button', { name: /Оплатить в Payme/ }); // «Загрузка…» while the link is prepared
    await waitFor(() => expect((pay as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(pay);
    expect(tg.opened).toEqual([CHECKOUT]);
    expect(await screen.findByText(/Ждём подтверждения от Payme/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Открыть Payme ещё раз/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('Uzbek; once paid — «To‘lov tasdiqlandi» and the way to the order', async () => {
    order = { ...order, status: 'paid', payment_status: 'payment_success' } as Order;
    const onClose = vi.fn();
    show('uz', <PayReceiptSheet orderId="o1" provider="payme" onClose={onClose} />);
    expect(await screen.findByRole('dialog', { name: 'VITALO cheki' })).toBeTruthy();
    expect(await screen.findByText('To‘lov tasdiqlandi')).toBeTruthy();
    expect(screen.queryByRole('timer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Buyurtmaga o‘tish' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('the timer: minutes:seconds, hours when longer', () => {
    expect(clock(29 * 60 + 41)).toBe('29:41');
    expect(clock(65)).toBe('1:05');
    expect(clock(3600 + 5 * 60 + 9)).toBe('1:05:09');
  });
});

describe('6а-Г: one delivery term for an order «из США»', () => {
  const w = { expected_from: '2026-11-16', expected_to: '2026-11-23', guarantee_days: 30, foreign: true, from_ru: 'из США', from_uz: 'AQShdan' };

  it('the expected dates instead of «рабочих дней» (RU / UZ)', () => {
    const { container } = show('ru', <OrderTerm window={w} min={1} max={3} />);
    expect(container.textContent).toContain('Срок доставки: 16–23 ноября');
    expect(container.textContent).toContain('весь заказ привезём вместе с товарами из США');
    expect(container.textContent).not.toContain('рабоч');
    cleanup();
    const uz = show('uz', <OrderTerm window={w} min={1} max={3} />);
    expect(uz.container.textContent).toContain('Yetkazib berish muddati: 16–23-noyabr');
    expect(uz.container.textContent).toContain('AQShdan mahsulotlar bilan birga');
  });

  it('only local «под заказ» lines — the «под заказ» note; no window — the usual working days', async () => {
    const { container } = show('ru', <OrderTerm window={{ ...w, foreign: false }} min={1} max={3} />);
    expect(container.textContent).toContain('вместе с товарами под заказ');
    cleanup();
    show('ru', <OrderTerm window={null} min={1} max={3} />);
    expect(await screen.findByText(/Срок доставки: 1–3 рабочих дней/)).toBeTruthy();
  });
});
