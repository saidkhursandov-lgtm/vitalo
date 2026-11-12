import { describe, expect, it } from 'vitest';
import { dateTime, discountPercent, money, nameOf, normalizePhone, prettyPhone, textOf } from './format';
import { dictionaries, errorText, pluralForm, statusKey, translate } from './i18n';
import { createIdempotencyKeys, REUSE_MS } from './idempotency';
import { qs } from './api';

describe('i18n', () => {
  const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

  it('every Uzbek text is filled in and uses the same {placeholders} as Russian', () => {
    for (const [key, ru] of Object.entries(dictionaries.ru)) {
      const uz = dictionaries.uz[key as keyof typeof dictionaries.ru];
      expect(uz.trim(), key).not.toBe('');
      expect(placeholders(uz), key).toEqual(placeholders(ru));
    }
  });

  it('"Показать N товаров" uses the right Russian word form', () => {
    const show = (n: number) => translate('ru', `catalog.show.${pluralForm(n)}`, { n });
    expect(show(1)).toBe('Показать 1 товар');
    expect(show(3)).toBe('Показать 3 товара');
    expect(show(5)).toBe('Показать 5 товаров');
    expect(show(11)).toBe('Показать 11 товаров');
    expect(show(21)).toBe('Показать 21 товар');
    expect(show(0)).toBe('Показать 0 товаров');
  });

  it('order status labels: no emoji, "Оплата проверяется" after «Я оплатил(а)»', () => {
    expect(translate('ru', statusKey('awaiting_payment'))).toBe('Ожидает оплаты');
    expect(translate('ru', statusKey('awaiting_payment', true))).toBe('Оплата проверяется');
    expect(translate('ru', statusKey('paid', true))).toBe('Оплачен');
    expect(translate('ru', statusKey('cancelled'))).toBe('Отменён');
  });

  it('no emoji in Mini App texts (icons are SVG)', () => {
    const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    for (const dict of Object.values(dictionaries)) {
      for (const [key, text] of Object.entries(dict)) expect(emoji.test(text), key).toBe(false);
    }
  });

  it('fills placeholders', () => {
    expect(translate('ru', 'orders.number', { n: 'VTL-20261002-0001' })).toBe('Заказ №VTL-20261002-0001');
    expect(translate('uz', 'catalog.found', { n: 7 })).toBe('Topilgan mahsulotlar: 7');
  });

  it('maps API error codes, unknown codes fall back to a generic text', () => {
    expect(errorText('ru', 'INSUFFICIENT_STOCK')).toMatch(/Недостаточно товара/);
    expect(errorText('uz', 'SOMETHING_NEW')).toBe(dictionaries.uz['common.error']);
    expect(errorText('ru', undefined)).toBe(dictionaries.ru['common.error']);
  });
});

describe('format', () => {
  it('money in sum / so‘m with thin grouping', () => {
    expect(money(89000, 'ru')).toBe('89 000 сум');
    expect(money(1234567, 'uz')).toBe('1 234 567 so‘m');
    expect(money(0, 'ru')).toBe('0 сум');
  });

  it('shows dates in Tashkent time', () => {
    expect(dateTime('2026-10-02T19:30:00Z', 'ru')).toContain('03.10.2026'); // 00:30 next day in Tashkent
  });

  it('Uzbek names fall back to Russian', () => {
    expect(nameOf({ name_ru: 'Цинк', name_uz: 'Rux' }, 'uz')).toBe('Rux');
    expect(nameOf({ name_ru: 'Цинк', name_uz: null }, 'uz')).toBe('Цинк');
    expect(textOf({ directions_ru: 'Утром', directions_uz: null }, 'directions', 'uz')).toBe('Утром');
    expect(textOf({ directions_ru: '  ' }, 'directions', 'ru')).toBeNull();
  });

  it('discount percent only when the old price is higher', () => {
    expect(discountPercent(65000, 79000)).toBe(18);
    expect(discountPercent(65000, null)).toBeNull();
    expect(discountPercent(65000, 60000)).toBeNull();
  });

  it('D-09: no crossed-out price and no percent for a discount above 25%', () => {
    expect(discountPercent(75000, 100000)).toBe(25); // exactly 25% is still shown
    expect(discountPercent(74000, 100000)).toBeNull(); // 26%
    expect(discountPercent(30000, 100000)).toBeNull(); // 70%
  });

  it('normalizes Uzbek phone numbers', () => {
    expect(normalizePhone('90 123-45-67')).toBe('+998901234567');
    expect(normalizePhone('+998 (90) 123 45 67')).toBe('+998901234567');
    expect(normalizePhone('12345')).toBeNull();
    expect(prettyPhone('+998901234567')).toBe('+998 90 123 45 67');
  });

  it('builds query strings without empty values', () => {
    expect(qs({ category: 'vitamins', brand: ['A', 'B'], form: [], price_min: undefined, in_stock: true })).toBe('?category=vitamins&brand=A%2CB&in_stock=true');
    expect(qs({ q: '' })).toBe('');
  });
});

describe('idempotency keys', () => {
  it('the same order form keeps its key (retry / double tap), a changed form gets a new one', () => {
    const keys = createIdempotencyKeys();
    const body = { source: 'cart', city_id: 'c1' };
    const first = keys.keyFor(body);
    expect(keys.keyFor({ ...body })).toBe(first);
    expect(keys.keyFor({ ...body, city_id: 'c2' })).not.toBe(first);
  });

  it('аудит 2.2: the checkout opened anew (back, reload) reuses the key for a short while; later the same cart is a new order', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as unknown as Storage;
    let now = 1_000_000;
    const body = { source: 'cart', city_id: 'c1' };
    const first = createIdempotencyKeys(storage, () => now).keyFor(body);
    now += 60_000; // a minute later, a new checkout screen
    expect(createIdempotencyKeys(storage, () => now).keyFor({ ...body })).toBe(first);
    now += REUSE_MS + 1;
    expect(createIdempotencyKeys(storage, () => now).keyFor({ ...body })).not.toBe(first);
    // storage that throws (private mode) still works in memory
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    const k = createIdempotencyKeys(broken);
    expect(k.keyFor(body)).toBe(k.keyFor({ ...body }));
  });
});

describe('telegram helpers', () => {
  it('start param: signed one from Telegram, else ?startapp=, only valid codes', async () => {
    const { startParam } = await import('./telegram');
    window.history.replaceState(null, '', '/?startapp=FRIEND_42');
    expect(startParam()).toBe('FRIEND_42');
    window.history.replaceState(null, '', '/?startapp=bad%20code');
    expect(startParam()).toBeUndefined();
    window.Telegram = { WebApp: { initData: 'x', initDataUnsafe: { start_param: 'SIGNED' } } as never };
    expect(startParam()).toBe('SIGNED');
    delete window.Telegram;
    window.history.replaceState(null, '', '/');
  });

  it('dev login only on this computer', async () => {
    const { isLocalDevHost } = await import('./telegram');
    expect(isLocalDevHost('localhost')).toBe(true);
    expect(isLocalDevHost('quiet-river.trycloudflare.com')).toBe(false);
  });
});
