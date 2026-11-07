import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { navFor } from './lib/nav';
import { CardPreview, fromLocal, periodLabel, problemText, SKIN, SkinBadge, STATE, toLocal, type ItemCheck } from './pages/Campaigns';

/** money() puts non-breaking spaces between thousands. */
const plain = (s: string | null) => (s ?? '').replace(/[  ]/g, ' ');
const item: ItemCheck = { product_id: 'p1', sku: 'A001', name: 'Магний B6', list_price_uzs: 100_000, price_uzs: 80_000, discount_pct: 20, floor_uzs: 77_000, max_pct: 35, cost_known: true, problem: null, conflict: null };

describe('3.7 Акции', () => {
  it('«Акции» for admin, marketer, manager (view); 3.2 promo messages are now «Рассылки»', () => {
    expect(navFor(['promo.view', 'promo.send']).map((n) => n.label)).toEqual(['Акции', 'Промокоды', 'Рассылки']); // генплан, этап 2: «Маркетинг»
  });

  it('skins and states have labels', () => {
    expect(Object.values(SKIN)).toEqual(['Без плашки', 'Black Friday', '11.11', 'Акция']);
    expect(Object.values(STATE).map((s) => s[0])).toEqual(['Идёт', 'Запланирована', 'Закончилась', 'Выключена']);
  });

  it('warnings while typing: 35% / 25%, margin floor, no cost, one product — one sale', () => {
    expect(problemText({ ...item, problem: 'too_big' }, 20)).toBe('Скидка больше 35% (D-28)');
    expect(problemText({ ...item, problem: 'too_big', max_pct: 25 }, 20)).toBe('Без даты окончания скидка — не больше 25%');
    expect(plain(problemText({ ...item, problem: 'below_margin' }, 20))).toBe('Ниже границы маржи: не дешевле 77 000 сум');
    expect(plain(problemText({ ...item, problem: 'below_margin', cost_known: false, floor_uzs: 80_000 }, 20))).toBe('Нет закупочной цены: скидка не больше 20% (не дешевле 80 000 сум)');
    expect(problemText({ ...item, conflict: { id: 'c2', title: '11.11' } }, 20)).toContain('Уже в акции «11.11»');
    expect(problemText(item, 20)).toBeNull();
  });

  it('dates are Tashkent time both ways', () => {
    expect(toLocal('2026-11-10T19:00:00.000Z')).toBe('2026-11-11T00:00');
    expect(new Date(fromLocal('2026-11-11T00:00')).toISOString()).toBe('2026-11-10T19:00:00.000Z');
    expect(periodLabel({ start_at: '2026-11-10T19:00:00.000Z', end_at: null })).toBe('11.11.2026 00:00 — без даты окончания');
  });

  it('preview: badge with % and skin, old price crossed out, new price in the skin colour', () => {
    const { container } = render(<CardPreview skin="black_friday" title="Black Friday" item={item} />);
    expect(screen.getByText('−20%').closest('.skin-badge')?.className).toContain('skin-black_friday');
    expect(container.querySelector('.camp-preview')?.className).toContain('skin-card-black_friday');
    expect(plain(container.querySelector('.camp-preview-old')?.textContent ?? '')).toBe('100 000 сум');
    expect(container.querySelector('.camp-preview-price')?.className).toContain('skin-price-black_friday');
  });

  it('«Без плашки» — no badge, only prices', () => {
    const { container } = render(<CardPreview skin="none" title="" item={item} />);
    expect(container.querySelector('.skin-badge')).toBeNull();
    render(<SkinBadge skin="none" pct={null} />);
    expect(screen.getByText('Без плашки')).toBeTruthy();
  });
});
