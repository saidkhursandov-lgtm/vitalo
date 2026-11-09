import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { dateRange, dayMonth, daysRange, UsaBadge, UsaTracking, UsaWindowNotice } from './components/CrossBorder';
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
    expect(screen.getByText(/Оплата только онлайн или переводом.*на 21-й день/)).toBeTruthy();
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

describe('D-61: «под заказ» from a local supplier (Glorious Healthy Nutrition)', () => {
  it('«1–2 дня», «7–14 дней», «5 дней», UZ «kun»', () => {
    expect([daysRange(1, 2, 'ru'), daysRange(7, 14, 'ru'), daysRange(5, 5, 'ru'), daysRange(1, 21, 'ru'), daysRange(1, 2, 'uz')]).toEqual(['1–2 дня', '7–14 дней', '5 дней', '1–21 дня', '1–2 kun']);
  });

  it('the cart / checkout notice: no «из США», no «только предоплата»; the line mark is «Под заказ»', () => {
    wrap('ru', <><UsaWindowNotice window={{ expected_from: '2026-11-10', expected_to: '2026-11-11', guarantee_days: 7, foreign: false }} /><UsaBadge mark={{ kind: 'local' }} /><UsaBadge mark={{ kind: 'foreign', from_ru: 'из США' }} /></>);
    expect(screen.getByText('Товары под заказ. Ожидаемая доставка: 10–11 ноября')).toBeTruthy();
    expect(screen.queryByText(/Оплата только онлайн/)).toBeNull();
    expect(screen.getByText('Под заказ')).toBeTruthy();
    expect(screen.getByText('Из США')).toBeTruthy();
  });

  it('the order: three steps, «Заказан у поставщика», no money-back words before paying', () => {
    const tracking: CrossBorderTracking = {
      stage: 'ordered',
      kind: 'local',
      lines_waiting: 1,
      expected_from: '2026-11-10',
      expected_to: '2026-11-11',
      steps: [
        { stage: 'paid', done: true, at: '2026-11-09T05:00:00.000Z' },
        { stage: 'ordered', done: true, at: '2026-11-09T07:00:00.000Z' },
        { stage: 'in_stock', done: false, at: null },
      ],
      delays: [],
    };
    wrap('ru', <UsaTracking tracking={tracking} cancel={{ allowed: false, reason: null, guarantee_date: '2026-11-16' }} />);
    expect(screen.getByText('Где ваш заказ')).toBeTruthy();
    expect(screen.getByText('Заказан у поставщика').closest('li')?.className).toContain('is-current');
    expect(screen.queryByText(/США/)).toBeNull();
    expect(screen.getByText('Если товара не будет у нас до 16 ноября, вы сможете отменить заказ.')).toBeTruthy();
  });
});
