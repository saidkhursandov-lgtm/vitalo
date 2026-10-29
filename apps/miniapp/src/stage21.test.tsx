import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bannerHref, HomeCarousel } from './components/HomeBlocks';
import { OnlineSoon, OrderItems, OrderTotals } from './components/OrderItems';
import * as analytics from './lib/analytics';
import { formLabel, shortNameOf } from './lib/format';
import { I18nProvider } from './lib/i18n';
import type { Lang, ShopBanner } from './lib/types';

afterEach(cleanup);

const plain = (el: Element) => (el.textContent ?? '').replace(/ /g, ' ');

function wrap(lang: Lang, ui: React.ReactNode) {
  return render(
    <MemoryRouter>
      <I18nProvider lang={lang} setLang={() => undefined}>
        {ui}
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('short name (2.1)', () => {
  const full = { name_ru: 'Витамин D3 2000 МЕ, 60 капсул, Now Foods', name_uz: 'D3 vitamini 2000 XB, 60 kapsula' };
  it('short one first; Uzbek falls back to the full Uzbek name, then to Russian', () => {
    expect(shortNameOf({ ...full, short_name_ru: 'Витамин D3', short_name_uz: 'D3 vitamini' }, 'ru')).toBe('Витамин D3');
    expect(shortNameOf({ ...full, short_name_ru: 'Витамин D3', short_name_uz: 'D3 vitamini' }, 'uz')).toBe('D3 vitamini');
    expect(shortNameOf({ ...full, short_name_ru: 'Витамин D3' }, 'uz')).toBe(full.name_uz);
    expect(shortNameOf({ name_ru: full.name_ru, short_name_ru: 'Витамин D3' }, 'uz')).toBe('Витамин D3');
    expect(shortNameOf(full, 'ru')).toBe(full.name_ru);
  });

  it('«Ваш заказ»: short name, «× 2 · капсулы», price; free delivery and the first-order badge; big total', () => {
    const { container } = wrap(
      'ru',
      <>
        <OrderItems items={[{ product_id: 'p1', ...full, short_name_ru: 'Витамин D3', qty: 2, line_total_uzs: 178_000, form: 'капсулы', image_url: '/x.webp' }]} />
        <OrderTotals goods={178_000} delivery={0} firstOrder total={178_000} />
      </>,
    );
    const text = plain(container);
    expect(text).toContain('Витамин D3');
    expect(text).not.toContain('Now Foods');
    expect(text).toContain('× 2 · капсулы');
    expect(text).toContain('178 000 сум');
    expect(screen.getByText('Бесплатно').className).toBe('free-accent');
    expect(text).toContain('Первый заказ');
    expect(container.querySelector('.sum-row.total')?.textContent).toContain('Итого');
  });
});

describe('product form in Uzbek (2.1)', () => {
  it('every form in the database is translated; Russian stays as is', () => {
    expect(formLabel('Капсулы', 'uz')).toBe('Kapsula');
    expect(formLabel('Таблетки', 'uz')).toBe('Tabletka');
    expect(formLabel('Порошок', 'uz')).toBe('Kukun');
    expect(formLabel('Капсулы и таблетки (набор)', 'uz')).toBe('Kapsula va tabletka (to‘plam)');
    expect(formLabel('Порошок (саше)', 'uz')).toBe('Kukun (sashe)');
    expect(formLabel('Капсулы', 'ru')).toBe('Капсулы');
  });

  it('case and extra spaces do not matter; a non-standard form is shown as it is', () => {
    expect(formLabel('  жевательные   таблетки ', 'uz')).toBe('Chaynaladigan tabletka');
    expect(formLabel('ЖИДКОСТЬ', 'uz')).toBe('Suyuqlik');
    expect(formLabel('Масло в флаконе 30 мл', 'uz')).toBe('Масло в флаконе 30 мл');
  });

  it('«Ваш заказ» in Uzbek shows the form in Uzbek', () => {
    const { container } = wrap('uz', <OrderItems items={[{ product_id: 'p1', name_ru: 'Витамин D3', qty: 1, line_total_uzs: 76_000, form: 'Капсулы' }]} />);
    expect(plain(container)).toContain('× 1 · Kapsula');
  });
});

describe('Payme / Click / Uzum «Скоро» (D-20)', () => {
  beforeEach(() => vi.spyOn(analytics, 'track').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('logo buttons + disclaimer; a tap opens the sheet and counts payment_soon_click with the system', () => {
    wrap('ru', <OnlineSoon systems={['payme', 'click', 'uzum']} />);
    expect(screen.getByText('Онлайн-оплата скоро заработает')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(3);
    fireEvent.click(screen.getByLabelText('Uzum · Скоро'));
    expect(analytics.track).toHaveBeenCalledWith('payment_soon_click', { system: 'uzum' });
    expect(screen.getByRole('dialog').textContent).toContain('Оплата через Uzum скоро заработает. Сейчас можно оплатить переводом на карту или при получении (Ташкент)');
    fireEvent.click(screen.getByText('Понятно'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Uzbek texts; hidden systems are not shown at all', () => {
    wrap('uz', <OnlineSoon systems={['click']} />);
    expect(screen.getByText('Onlayn to‘lov tez orada ishga tushadi')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('Click · Tez orada'));
    expect(screen.getByRole('dialog').textContent).toContain('Click orqali to‘lov tez orada ishga tushadi');
    expect(screen.getByText('Tushunarli')).toBeTruthy();
  });

  it('nothing in «Скоро»: the block is not rendered', () => {
    const { container } = wrap('ru', <OnlineSoon systems={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('home banners from the admin panel (2.1)', () => {
  const doctor: ShopBanner = { id: 'b1', kind: 'doctor', image_url: null, image_jpeg_url: null, link: null };
  const delivery: ShopBanner = { id: 'b2', kind: 'delivery', image_url: null, image_jpeg_url: null, link: null };
  const picture: ShopBanner = { id: 'b3', kind: 'image', image_url: '/uploads/banners/b3/x-uz.webp', image_jpeg_url: '/uploads/banners/b3/x-uz.jpg', link: { type: 'category', value: 'vitamins' } };

  it('slides follow the admin order; a picture banner is WebP with a JPEG fallback and opens its link', () => {
    const { container } = wrap('uz', <HomeCarousel firstOrderFree freeFromUzs={250_000} banners={[picture, delivery, doctor]} />);
    const slides = [...container.querySelectorAll('.hero-slide')];
    expect(slides).toHaveLength(3);
    expect(slides[0].getAttribute('href')).toBe('/catalog/products?category=vitamins');
    expect(slides[0].querySelector('source')?.getAttribute('srcset')).toBe(picture.image_url);
    expect(slides[0].querySelector('img')?.getAttribute('src')).toBe(picture.image_jpeg_url);
    expect(plain(slides[1])).toMatch(/bepul/i); // the delivery slide keeps its rule
    expect(container.querySelectorAll('.hero-dots span')).toHaveLength(3);
  });

  it('delivery slide: first order free for a new customer, otherwise the threshold, neither — no slide', () => {
    expect(plain(wrap('ru', <HomeCarousel firstOrderFree freeFromUzs={250_000} banners={[delivery]} />).container)).toContain('Первый заказ');
    cleanup();
    expect(plain(wrap('ru', <HomeCarousel firstOrderFree={false} freeFromUzs={300_000} banners={[delivery]} />).container)).toContain('от 300 000 сум');
    cleanup();
    expect(wrap('ru', <HomeCarousel firstOrderFree={false} freeFromUzs={null} banners={[delivery]} />).container.querySelector('.hero')).toBeNull();
  });

  it('all banners off (empty list) — no banner block at all', () => {
    const { container } = wrap('ru', <HomeCarousel firstOrderFree freeFromUzs={250_000} banners={[]} />);
    expect(container.querySelector('.hero')).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('links: product, category, brand, none', () => {
    expect(bannerHref({ type: 'product', value: 'p-1' })).toBe('/product/p-1');
    expect(bannerHref({ type: 'brand', value: 'Now Foods' })).toBe('/brand/Now%20Foods');
    expect(bannerHref(null)).toBeNull();
  });
});
