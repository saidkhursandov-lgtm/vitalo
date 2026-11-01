import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderTotals } from './components/OrderItems';
import { PromoBox, type PromoApplyResult } from './components/Promo';
import { I18nProvider, translate } from './lib/i18n';
import type { Cart, Lang, PromoView } from './lib/types';
import { warningText } from './screens/Cart';

const applied: PromoView = {
  code: 'VITALO10',
  kind: 'percent',
  value: 10,
  discount_uzs: 20_000,
  free_delivery: false,
  capped: false,
  description_ru: 'Скидка 10% на первый заказ',
  description_uz: 'Birinchi buyurtmaga 10% chegirma',
  message_ru: 'Промокод VITALO10 применён (−20 000 сум)',
  message_uz: 'VITALO10 promokodi qo‘llandi (−20 000 so‘m)',
};

let events: { event: string; props?: Record<string, unknown> }[];
beforeEach(() => {
  events = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url.includes('/analytics/events')) events.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ accepted: true }));
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

describe('3.3 «У меня есть промокод»', () => {
  it('collapsed line → field + «Применить»; an error is shown in place and counted with the reason', async () => {
    const onApply = vi.fn(async (): Promise<PromoApplyResult> => ({ ok: false, reason: 'min_order', message: 'Промокод действует при заказе от 300 000 сум' }));
    show('ru', <PromoBox applied={null} place="cart" onApply={onApply} onRemove={async () => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /У меня есть промокод/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    expect(screen.getByRole('alert').textContent).toBe('Введите промокод'); // empty: nothing sent
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText('Например, VITALO10'), { target: { value: ' health50 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Промокод действует при заказе от 300 000 сум'));
    expect(onApply).toHaveBeenCalledWith('health50');
    await waitFor(() => expect(events).toContainEqual({ event: 'promo_apply_fail', props: { code: 'HEALTH50', reason: 'min_order', place: 'cart' } }));
  });

  it('success is counted; the applied code is a green line with the description and [✕]', async () => {
    const onApply = vi.fn(async (): Promise<PromoApplyResult> => ({ ok: true, promo: applied }));
    const onRemove = vi.fn(async () => undefined);
    const { rerender } = show('ru', <PromoBox applied={null} place="checkout" onApply={onApply} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: /У меня есть промокод/ }));
    fireEvent.change(screen.getByPlaceholderText('Например, VITALO10'), { target: { value: 'vitalo10' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Например, VITALO10'), { key: 'Enter' });
    await waitFor(() => expect(events).toContainEqual({ event: 'promo_apply_success', props: { code: 'VITALO10', discount_uzs: 20_000, place: 'checkout' } }));

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <I18nProvider lang="ru" setLang={() => undefined}>
            <PromoBox applied={applied} place="checkout" onApply={onApply} onRemove={onRemove} />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('status').textContent).toContain('Промокод VITALO10 применён (−20 000 сум)');
    expect(screen.getByRole('status').textContent).toContain('Скидка 10% на первый заказ');
    fireEvent.click(screen.getByRole('button', { name: 'Убрать промокод' }));
    await waitFor(() => expect(onRemove).toHaveBeenCalled());
    await waitFor(() => expect(events).toContainEqual({ event: 'promo_remove', props: { code: 'VITALO10', place: 'checkout' } }));
  });

  it('Uzbek texts; the margin note when the discount was cut', () => {
    show('uz', <PromoBox applied={null} place="cart" onApply={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Promokodim bor/ })).toBeTruthy();
    cleanup();
    show('uz', <PromoBox applied={{ ...applied, capped: true }} place="cart" onApply={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('VITALO10 promokodi qo‘llandi (−20 000 so‘m)');
    expect(screen.getByRole('status').textContent).toContain(translate('uz', 'promo.capped'));
  });
});

describe('3.3 totals', () => {
  it('the discount is its own line; goods are shown before it', () => {
    show('ru', <OrderTotals goods={200_000} discount={20_000} promo={{ code: 'VITALO10', free_delivery: false }} delivery={35_000} total={215_000} />);
    const rows = [...document.querySelectorAll('.sum-row')].map((r) => r.textContent?.replace(/\s/g, ' '));
    expect(rows[0]).toMatch(/Товары.*200 000/);
    expect(rows[1]).toMatch(/Промокод VITALO10.*−20 000/);
    expect(rows[3]).toMatch(/Итого.*215 000/);
  });

  it('free delivery by a code: «Бесплатно» with the code badge, no money line', () => {
    show('ru', <OrderTotals goods={100_000} promo={{ code: 'FREEDEL', free_delivery: true }} delivery={0} total={100_000} />);
    expect(document.querySelector('.promo-row')).toBeNull();
    expect(document.querySelector('.first-order-badge')?.textContent).toBe('промокод FREEDEL');
  });

  it('a removed code becomes a cart warning with the server reason', () => {
    const cart = { items: [] } as unknown as Cart;
    const w = { code: 'promo_removed' as const, promo_code: 'HEALTH50', reason: 'min_order', message_ru: 'Промокод действует при заказе от 300 000 сум', message_uz: 'x' };
    expect(warningText(w, cart, 'ru', (k, p) => translate('ru', k, p))).toBe('Промокод HEALTH50: Промокод действует при заказе от 300 000 сум');
  });
});
