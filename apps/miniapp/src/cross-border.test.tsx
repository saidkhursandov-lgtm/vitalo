import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { dateRange, dayMonth, UsaTracking, UsaWindowNotice } from './components/CrossBorder';
import { I18nProvider } from './lib/i18n';
import type { CrossBorderTracking, Lang } from './lib/types';

afterEach(cleanup);

const wrap = (lang: Lang, node: React.ReactNode) =>
  render(
    <MemoryRouter>
      <I18nProvider lang={lang} setLang={() => undefined}>
        {node}
      </I18nProvider>
    </MemoryRouter>,
  );

describe('D-60: «Под заказ из США» on the customer side', () => {
  it('dates: one month, two months, one day, RU and UZ', () => {
    expect(dateRange('2026-11-16', '2026-11-23', 'ru')).toBe('16–23 ноября');
    expect(dateRange('2026-11-28', '2026-12-05', 'ru')).toBe('28 ноября – 5 декабря');
    expect(dateRange('2026-11-30', '2026-11-30', 'uz')).toBe('30-noyabr');
    expect(dayMonth('2026-01-02', 'uz')).toBe('2-yanvar');
  });

  it('before paying: the window, prepayment only and the money-back term', () => {
    wrap('ru', <UsaWindowNotice window={{ expected_from: '2026-11-16', expected_to: '2026-11-23', guarantee_days: 21 }} />);
    expect(screen.getByText('Товары из США. Ожидаемая доставка: 16–23 ноября')).toBeTruthy();
    expect(screen.getByText(/Оплата только онлайн или переводом.*через 21 дней/)).toBeTruthy();
  });

  it('the order: every stage, the moved date with its reason, from which day the money can be returned', () => {
    const tracking: CrossBorderTracking = {
      stage: 'shipped',
      lines_waiting: 1,
      expected_from: '2026-11-30',
      expected_to: '2026-11-30',
      steps: [
        { stage: 'paid', done: true, at: '2026-11-09T05:00:00.000Z' },
        { stage: 'ordered', done: true, at: '2026-11-10T05:00:00.000Z' },
        { stage: 'shipped', done: true, at: '2026-11-12T20:00:00.000Z' },
        { stage: 'arrived_uz', done: false, at: null },
        { stage: 'in_stock', done: false, at: null },
      ],
      delays: [{ at: '2026-11-20T05:00:00.000Z', expected_to: '2026-11-30', reason: 'таможня' }],
    };
    wrap('uz', <UsaTracking tracking={tracking} cancel={{ allowed: false, reason: null, guarantee_date: '2026-11-30' }} />);
    expect(screen.getByText('AQShdan buyurtmangiz qayerda')).toBeTruthy();
    expect(screen.getByText('AQShdan jo‘natildi').closest('li')?.className).toContain('is-current');
    // 20:00 UTC is already the next day in Tashkent
    expect(screen.getByText('13-noyabr')).toBeTruthy();
    expect(screen.getByText(/Muddat surildi: 30-noyabr gacha/)).toBeTruthy();
    expect(screen.getByText(/Sabab: таможня/)).toBeTruthy();
    expect(screen.getByText(/Agar mahsulot 30-noyabr gacha bizda bo‘lmasa/)).toBeTruthy();
  });
});
