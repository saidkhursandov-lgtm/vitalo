import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingCart } from './components/FloatingCart';
import { DoctorBadge, LangSwitch } from './components/HeaderParts';
import { HomeCarousel, TrustChips } from './components/HomeBlocks';
import { StatusPill } from './components/ui';
import * as analytics from './lib/analytics';
import { I18nProvider, translate } from './lib/i18n';
import type { Lang } from './lib/types';

afterEach(cleanup);

/** money() uses a non-breaking space between thousands. */
const plain = (el: Element) => (el.textContent ?? '').replace(/ /g, ' ');

function wrap(lang: Lang, ui: React.ReactNode, setLang: (l: Lang) => void = () => undefined) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <I18nProvider lang={lang} setLang={setLang}>
          {ui}
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('floating cart (release 1, item 7)', () => {
  it.each([
    [1, 'В корзине 1 товар'],
    [3, 'В корзине 3 товара'],
    [5, 'В корзине 5 товаров'],
    [11, 'В корзине 11 товаров'],
    [21, 'В корзине 21 товар'],
  ])('Russian word form for %i', (n, text) => {
    const { container } = wrap('ru', <FloatingCart count={n} total={245_000} />);
    expect(plain(container)).toContain(text);
    expect(plain(container)).toContain('245 000 сум');
    // the whole bar, the «Оформить» label included, opens the cart (+/−, delete); checkout starts from the cart
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(screen.getByText('Оформить').closest('a')?.getAttribute('href')).toBe('/cart');
  });

  it('Uzbek: «Savatda N ta mahsulot» and the sum in so‘m', () => {
    const { container } = wrap('uz', <FloatingCart count={3} total={90_000} />);
    expect(plain(container)).toContain('Savatda 3 ta mahsulot');
    expect(plain(container)).toContain('90 000 so‘m');
  });
});

describe('top bar (release 1, item 2)', () => {
  beforeEach(() => {
    vi.spyOn(analytics, 'track').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('doctor badge in both languages, the cross is an SVG icon (no emoji)', () => {
    const { container, unmount } = wrap('ru', <DoctorBadge />);
    expect(container.textContent).toBe('Выбор врача');
    expect(container.querySelector('svg')).not.toBeNull();
    unmount();
    expect(wrap('uz', <DoctorBadge />).container.textContent).toBe('Shifokor tanlovi');
  });

  it('RU | UZ: one tap switches the language and reports language_change; the current one does nothing', () => {
    const setLang = vi.fn();
    wrap('ru', <LangSwitch />, setLang);
    expect(screen.getByText('RU').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByText('RU'));
    expect(setLang).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('UZ'));
    expect(setLang).toHaveBeenCalledWith('uz');
    expect(analytics.track).toHaveBeenCalledWith('language_change', { to: 'uz' });
  });
});

describe('home (release 1, item 3)', () => {
  it('carousel, 2nd slide: a new customer sees the first-order offer', () => {
    const { container } = wrap('ru', <HomeCarousel firstOrderFree freeFromUzs={250_000} />);
    expect(container.textContent).toContain('Отбор врачом');
    expect(container.textContent).toContain('4,9');
    expect(container.textContent).toContain('Первый заказ — бесплатная доставка');
    expect(container.textContent).toContain('Доставка по всему Узбекистану');
    expect(plain(container)).not.toContain('от 250 000');
    expect(container.querySelectorAll('.hero-slide')).toHaveLength(2);
  });

  it('carousel, 2nd slide: everybody else sees «Бесплатная доставка от {порог}» with the threshold from the tariff', () => {
    const ru = wrap('ru', <HomeCarousel firstOrderFree={false} freeFromUzs={250_000} />);
    expect(plain(ru.container)).toContain('Бесплатная доставка от 250 000 сум');
    expect(ru.container.textContent).toContain('Доставка по всему Узбекистану');
    ru.unmount();
    expect(plain(wrap('ru', <HomeCarousel firstOrderFree={false} freeFromUzs={300_000} />).container)).toContain('от 300 000 сум'); // not a number from the code
  });

  it('carousel, 2nd slide in Uzbek; without a threshold only the first slide', () => {
    const first = wrap('uz', <HomeCarousel firstOrderFree freeFromUzs={250_000} />);
    expect(first.container.textContent).toContain('Birinchi buyurtma — bepul yetkazib berish');
    first.unmount();
    const from = wrap('uz', <HomeCarousel firstOrderFree={false} freeFromUzs={250_000} />);
    expect(plain(from.container)).toContain('250 000 so‘mdan bepul yetkazib berish');
    expect(from.container.textContent).toContain('Butun O‘zbekiston bo‘ylab');
    from.unmount();
    expect(wrap('ru', <HomeCarousel firstOrderFree={false} freeFromUzs={null} />).container.querySelectorAll('.hero-slide')).toHaveLength(1);
  });

  it('three trust chips under the search', () => {
    const { container } = wrap('ru', <TrustChips />);
    expect(Array.from(container.querySelectorAll('.chip')).map((c) => c.textContent)).toEqual(['100% оригинал', 'Отбор врачом', 'Ташкент 1–3 дня']);
  });
});

describe('cash on delivery texts', () => {
  it('the bottom button says «Подтвердить заказ • X» / «Buyurtmani tasdiqlash • X»', () => {
    expect(translate('ru', 'checkout.confirmCod', { sum: '125 000 сум' })).toBe('Подтвердить заказ • 125 000 сум');
    expect(translate('uz', 'checkout.confirmCod', { sum: '125 000 so‘m' })).toBe('Buyurtmani tasdiqlash • 125 000 so‘m');
    expect(translate('ru', 'checkout.confirm', { sum: '1' })).toContain('Оплатить');
  });

  it('status «Ожидает подтверждения» / «Tasdiqlash kutilmoqda»', () => {
    expect(translate('ru', 'status.codWaiting')).toBe('Ожидает подтверждения');
    expect(translate('uz', 'status.codWaiting')).toBe('Tasdiqlash kutilmoqda');
  });
});

describe('cash on delivery order status', () => {
  it('a new «при получении» order waits for the manager, not for a payment', () => {
    expect(wrap('ru', <StatusPill status="new" cod />).container.textContent).toBe('Ожидает подтверждения');
    cleanup();
    expect(wrap('ru', <StatusPill status="new" />).container.textContent).toBe('Ожидает оплаты');
    cleanup();
    expect(wrap('ru', <StatusPill status="paid" cod />).container.textContent).toBe('Оплачен');
  });
});
