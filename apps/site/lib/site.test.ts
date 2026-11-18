import { describe, expect, it } from 'vitest';
import { errorText, productsCount, t } from './i18n';
import { addToGuestCart, setGuestQty } from './client';
import { qs } from './server-api';
import { formatUzPhone, safeNext } from '../app/login/LoginForm';
import { hrefWith, parseQuery } from '../components/CatalogView';
import { cardGroups, dedupeHistory } from '../app/order/[id]/OrderView';
import { sitePath } from '../components/AccountShell';
import { opKey } from '../app/account/bonus/BonusView';
import { acceptPhotos } from '../components/PhotoPicker';
import { createIdempotencyKeys } from './idempotency';

describe('texts', () => {
  it('Russian plural for product counts, Uzbek without it', () => {
    expect(productsCount('ru', 1)).toBe('1 товар');
    expect(productsCount('ru', 3)).toBe('3 товара');
    expect(productsCount('ru', 11)).toBe('11 товаров');
    expect(productsCount('ru', 22)).toBe('22 товара');
    expect(productsCount('ru', 25)).toBe('25 товаров');
    expect(productsCount('uz', 7)).toBe('7 ta mahsulot');
  });

  it('fills parameters and falls back to a general error', () => {
    expect(t('ru', 'catalog.found', { n: 12 })).toBe('Найдено: 12');
    expect(t('uz', 'cart.goods', { n: 2 })).toBe('Mahsulotlar (2)');
    expect(errorText('ru', 'NO_SUCH_CODE')).toBe(t('ru', 'common.error'));
    expect(errorText('uz', 'BAD_PHONE')).toContain('+998');
  });

  it('Uzbek uses the ‘ letter (U+2018), not an apostrophe', () => {
    expect(t('uz', 'home.how4')).toBe('Butun mamlakat bo‘ylab');
    expect(t('uz', 'nav.sets')).not.toMatch(/['’`]/);
  });
});

describe('guest cart (before sign-in)', () => {
  it('adds like the server cart: the quantity grows, max 99', () => {
    let lines = addToGuestCart([], 'a', 1);
    lines = addToGuestCart(lines, 'a', 2);
    lines = addToGuestCart(lines, 'b', 1);
    expect(lines).toEqual([
      { product_id: 'a', qty: 3 },
      { product_id: 'b', qty: 1 },
    ]);
    expect(addToGuestCart(lines, 'a', 500)[0].qty).toBe(99);
  });

  it('quantity 0 removes the line', () => {
    const lines = [{ product_id: 'a', qty: 2 }];
    expect(setGuestQty(lines, 'a', 5)).toEqual([{ product_id: 'a', qty: 5 }]);
    expect(setGuestQty(lines, 'a', 0)).toEqual([]);
  });
});

describe('sign-in helpers', () => {
  it('formats an Uzbek phone while typing', () => {
    expect(formatUzPhone('901234567')).toBe('+998 90 123 45 67');
    expect(formatUzPhone('+998 (90) 123-45-67 999')).toBe('+998 90 123 45 67');
    expect(formatUzPhone('')).toBe('+998');
  });

  it('returns only to a page of this site after sign-in', () => {
    expect(safeNext('/cart')).toBe('/cart');
    expect(safeNext('//evil.example')).toBe('/account');
    expect(safeNext('https://evil.example')).toBe('/account');
    expect(safeNext('/login?next=/cart')).toBe('/account');
    expect(safeNext(null)).toBe('/account');
  });
});

describe('checkout and order page', () => {
  it('shows the card number in groups of four', () => {
    expect(cardGroups('8600123412341234')).toBe('8600 1234 1234 1234');
    expect(cardGroups('8600 1234-1234 1234')).toBe('8600 1234 1234 1234');
  });

  it('one key per order body: a repeated click does not create a second order', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const keys = createIdempotencyKeys(storage as Storage, () => 1000);
    const a = keys.keyFor({ source: 'cart', city_id: 'x' });
    expect(keys.keyFor({ source: 'cart', city_id: 'x' })).toBe(a);
    expect(keys.keyFor({ source: 'cart', city_id: 'y' })).not.toBe(a);
  });
});

describe('account (stage 6.4)', () => {
  const ID = '6f1c2a7e-0d5b-4c1a-9a2e-1b2c3d4e5f60';

  it('opens notification links on the site, not Mini App addresses', () => {
    expect(sitePath(`/orders/${ID}`)).toBe(`/order/${ID}`);
    expect(sitePath(`/orders/${ID}/pay`)).toBe(`/order/${ID}`);
    expect(sitePath(`/orders/${ID}/return`)).toBe(`/order/${ID}/return`);
    expect(sitePath(`/support/${ID}`)).toBe(`/account/support/${ID}`);
    expect(sitePath('/bonus')).toBe('/account/bonus');
    expect(sitePath(`/review/${ID}`)).toBe(`/review/${ID}`);
    expect(sitePath('/product/magniy-b6')).toBe('/product/magniy-b6');
    expect(sitePath('/campaign/black-friday')).toBe('/');
    expect(sitePath(null)).toBeNull();
  });

  it('names bonus history lines like the Mini App', () => {
    expect(opKey({ op: 'reversal', amount_uzs: 5000 })).toBe('bonus.op.refund');
    expect(opKey({ op: 'reversal', amount_uzs: -5000 })).toBe('bonus.op.unpurchase');
    expect(opKey({ op: 'referral', amount_uzs: 10000 })).toBe('bonus.op.manual_add');
    expect(opKey({ op: 'purchase', amount_uzs: 3000 })).toBe('bonus.op.purchase');
  });

  it('keeps only JPG/PNG/WEBP photos up to 10 MB and the limit', () => {
    const file = (type: string, size = 1000) => ({ type, size }) as File;
    const r = acceptPhotos([file('image/jpeg')], [file('image/png'), file('application/pdf'), file('image/webp', 11 * 1024 * 1024), file('image/webp')], 2);
    expect(r.photos.length).toBe(2);
    expect(r.rejected).toBe(true);
    expect(acceptPhotos([], [file('image/webp')], 3).rejected).toBe(false);
  });

  it('shows a repeated status once in the order history', () => {
    const h = [{ to_status: 'new' }, { to_status: 'new' }, { to_status: 'awaiting_payment' }, { to_status: 'paid' }];
    expect(dedupeHistory(h).map((x) => x.to_status)).toEqual(['new', 'awaiting_payment', 'paid']);
  });
});

describe('catalog addresses', () => {
  it('reads filters from the address and ignores junk', () => {
    const q = parseQuery({ brand: ['MioPharm', 'NOW'], form: 'Капсулы', price_min: '10000', price_max: 'abc', in_stock: '1', sort: 'hack', page: '2' }, 'sleep');
    expect(q).toEqual({ category: 'sleep', brand: ['MioPharm', 'NOW'], form: ['Капсулы'], price_min: 10000, price_max: undefined, in_stock: true, sort: undefined, page: 2 });
  });

  it('builds page links that keep the filters', () => {
    const q = parseQuery({ brand: 'NOW', sort: 'price_asc' });
    expect(hrefWith('/catalog/sleep', q, { page: 3 })).toBe('/catalog/sleep?brand=NOW&sort=price_asc&page=3');
    expect(hrefWith('/catalog', parseQuery({}), { page: 1 })).toBe('/catalog');
  });

  it('API query string skips empty values', () => {
    expect(qs({ category: 'sleep', brand: ['A', 'B'], in_stock: false, page: undefined })).toBe('?category=sleep&brand=A%2CB');
    expect(qs({})).toBe('');
  });
});
