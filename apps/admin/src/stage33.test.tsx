import { describe, expect, it } from 'vitest';
import { navFor } from './lib/nav';
import { conditionsLabel, STATE, typeLabel as rawType, type PromoCode } from './pages/PromoCodes';

/** money() puts non-breaking spaces between thousands. */
const plain = (s: string) => s.replace(/ | /g, ' ');
const typeLabel = (p: Pick<PromoCode, 'type' | 'value'>) => plain(rawType(p));

const base: PromoCode = {
  id: 'p1',
  code: 'VITALO10',
  type: 'percent',
  value: 10,
  scope: 'order',
  product_ids: [],
  brand_ids: [],
  targets_label: '',
  min_order_uzs: null,
  first_order_only: false,
  global_limit: 100,
  per_customer_limit: 1,
  start_at: '2026-11-01T00:00:00+05:00',
  end_at: '2026-11-30T23:59:59+05:00',
  active: true,
  description_ru: null,
  description_uz: null,
  state: 'active',
  used: 3,
  used_paid: 2,
  discount_total_uzs: 60_000,
  revenue_uzs: 540_000,
};

describe('3.3 Промокоды', () => {
  it('«Промокоды» for admin, marketer and manager (view), not for warehouse', () => {
    expect(navFor(['promo.view']).map((n) => n.label)).toEqual(['Промокоды']);
    expect(navFor(['orders.view', 'inventory.view']).map((n) => n.label)).not.toContain('Промокоды');
  });

  it('discount in the table: percent, sum, free delivery', () => {
    expect(typeLabel(base)).toBe('−10%');
    expect(typeLabel({ type: 'fixed', value: 20_000 })).toBe('−20 000 сум');
    expect(typeLabel({ type: 'free_delivery', value: 0 })).toBe('Бесплатная доставка');
  });

  it('conditions in one line', () => {
    expect(plain(conditionsLabel(base))).toBe('Вся корзина · 1 на клиента');
    expect(plain(conditionsLabel({ ...base, scope: 'brand', targets_label: 'Solgar, NOW', min_order_uzs: 300_000, first_order_only: true, per_customer_limit: 2 }))).toBe(
      'Бренды: Solgar, NOW · от 300 000 сум · только первый заказ · 2 на клиента',
    );
  });

  it('every state has a Russian label', () => {
    expect(Object.values(STATE).map((s) => s[0])).toEqual(['Действует', 'Запланирован', 'Закончился', 'Лимит исчерпан', 'Выключен']);
  });
});
