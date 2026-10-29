import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingCart } from './components/FloatingCart';
import { DoctorBadge, LangSwitch } from './components/HeaderParts';
import { HomeCarousel, TrustChips } from './components/HomeBlocks';
import { StatusPill } from './components/ui';
import * as analytics from './lib/analytics';
import { I18nProvider } from './lib/i18n';
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
    expect(screen.getByText('Оформить').getAttribute('href')).toBe('/checkout');
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
  it('carousel: the free-delivery slide is shown only while the switch is on', () => {
    const off = wrap('ru', <HomeCarousel freeFirstOrder={false} />);
    expect(off.container.textContent).toContain('Отбор врачом');
    expect(off.container.textContent).toContain('4,9');
    expect(off.container.textContent).not.toContain('Бесплатная доставка первого заказа');
    off.unmount();
    const on = wrap('ru', <HomeCarousel freeFirstOrder />);
    expect(on.container.textContent).toContain('Бесплатная доставка первого заказа');
    expect(on.container.querySelectorAll('.hero-slide')).toHaveLength(2);
  });

  it('three trust chips under the search', () => {
    const { container } = wrap('ru', <TrustChips />);
    expect(Array.from(container.querySelectorAll('.chip')).map((c) => c.textContent)).toEqual(['100% оригинал', 'Отбор врачом', 'Ташкент 1–3 дня']);
  });
});

describe('cash on delivery order status', () => {
  it('a new «при получении» order waits for the manager, not for a payment', () => {
    expect(wrap('ru', <StatusPill status="new" cod />).container.textContent).toBe('Ожидает подтверждения менеджером');
    cleanup();
    expect(wrap('ru', <StatusPill status="new" />).container.textContent).toBe('Ожидает оплаты');
    cleanup();
    expect(wrap('ru', <StatusPill status="paid" cod />).container.textContent).toBe('Оплачен');
  });
});
