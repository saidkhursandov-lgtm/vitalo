import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BonusCard, BonusSwitch, CashbackLine, cashbackOf } from './components/Bonus';
import { OrderTotals } from './components/OrderItems';
import { I18nProvider } from './lib/i18n';
import type { BonusAccount, BonusView, Lang } from './lib/types';
import { BonusScreen } from './screens/Bonus';

const plain = (s: string | null | undefined) => (s ?? '').replace(/[\u00a0\u202f]/g, ' ');

const view = (over: Partial<BonusView> = {}): BonusView => ({
  balance_uzs: 22_500,
  available_uzs: 15_000,
  use: false,
  used_uzs: 0,
  blocked: null,
  cashback_pct: 3,
  cashback_uzs: 1_569,
  max_spend_pct: 25,
  ...over,
});

const account: BonusAccount = {
  balance_uzs: 22_500,
  expires_on: '2027-02-12',
  last_activity_at: '2026-11-14T10:00:00.000Z',
  rules: { enabled: true, cashback_pct: 3, max_spend_pct: 25, lifetime_days: 90, review_uzs: 3000, review_photo_uzs: 5000 },
  history: [
    { id: '3', op: 'reversal', amount_uzs: 15_000, balance_after_uzs: 22_500, order_id: 'o2', order_number: 'V-2', created_at: '2026-11-14T10:00:00.000Z' },
    { id: '2', op: 'redemption', amount_uzs: -15_000, balance_after_uzs: 7_500, order_id: 'o2', order_number: 'V-2', created_at: '2026-11-13T10:00:00.000Z' },
    { id: '1', op: 'purchase', amount_uzs: 22_500, balance_after_uzs: 22_500, order_id: 'o1', order_number: 'V-1', created_at: '2026-11-12T10:00:00.000Z' },
  ],
};

beforeEach(() => {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/bonus')) return new Response(JSON.stringify(account));
    if (url.includes('/catalog/texts') || url.includes('/catalog/shop')) return new Response(JSON.stringify({ bonus: { enabled: true, cashback_pct: 3, max_spend_pct: 25 } }));
    return new Response(JSON.stringify({}));
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

describe('3.10-А VITALO Bonus in the Mini App', () => {
  it('cart switch: «Списать 15 000 бонусных сум», the balance under it; a tap asks the server', () => {
    const onToggle = vi.fn();
    show('ru', <BonusSwitch bonus={view()} onToggle={onToggle} />);
    const sw = screen.getByRole('switch');
    expect(plain(sw.closest('label')?.textContent)).toContain('Списать 15 000 бонусных сум');
    expect(plain(sw.closest('label')?.textContent)).toContain('На счёте 22 500 сум');
    fireEvent.click(sw);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('with a promo code: the reason instead of the switch; nothing on an empty balance', () => {
    const { rerender } = show('uz', <BonusSwitch bonus={view({ blocked: 'promo' })} onToggle={() => undefined} />);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('Bonuslarni promokod bilan birga ishlatib bo‘lmaydi')).toBeTruthy();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <I18nProvider lang="ru" setLang={() => undefined}>
            <BonusSwitch bonus={view({ blocked: 'empty', balance_uzs: 0 })} onToggle={() => undefined} />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText(/промокод/)).toBeNull();
  });

  it('totals: «Бонусы −15 000 сум» and the cashback line', () => {
    show('ru', (
      <>
        <OrderTotals goods={200_000} bonus={15_000} delivery={0} total={185_000} />
        <CashbackLine bonus={view()} />
      </>
    ));
    expect(plain(document.body.textContent)).toContain('Бонусы−15 000 сум');
    expect(plain(document.body.textContent)).toContain('+1 569 сум на бонусный счёт после доставки');
  });

  it('profile card and the bonus page: balance, «до 25%», when it burns, history with signs', async () => {
    show('ru', <BonusCard />);
    expect(plain((await screen.findByText(/22 500 сум/, { selector: '.bonus-balance' })).textContent)).toBe('22 500 сум');
    expect(screen.getByText('Оплачивайте бонусами до 25% заказа')).toBeTruthy();
    expect(plain(screen.getByText(/Сгорят/).textContent)).toBe('Сгорят 22 500 сум 12.02.2027');
    cleanup();

    show('ru', <BonusScreen />);
    const items = await screen.findAllByRole('listitem');
    const ops = items.filter((li) => li.className === 'bonus-op').map((li) => plain(li.textContent));
    expect(ops[0]).toContain('Бонусы вернулись');
    expect(ops[0]).toContain('+15 000 сум');
    expect(ops[1]).toContain('Оплата заказа');
    expect(ops[1]).toContain('−15 000 сум');
    expect(ops[2]).toContain('Кешбэк за заказ');
    expect(ops[2]).toContain('заказ №V-1');
  });

  it('product cashback: whole sum down from the price and the percent', () => {
    expect(cashbackOf(52_300, 3)).toBe(1_569);
    expect(cashbackOf(52_300, 0)).toBe(0);
  });
});
