import { paymeCheckoutUrl, paymeConfig, PAYME_CHECKOUT_LIVE, PAYME_CHECKOUT_TEST } from './payme-config';
import { fiscalGaps, paymeReceipt, type FiscalOrder } from './payme-fiscal';

const cfg = { deliveryIkpu: '10112006002000000', deliveryPackageCode: '1209885', vatPercent: 12 };
const line = (o: Partial<FiscalOrder['lines'][number]> = {}): FiscalOrder['lines'][number] => ({
  sku: 'A',
  title: 'Омега-3',
  qty: 2,
  unit_price_uzs: 100_000,
  line_total_uzs: 200_000,
  paid_line_total_uzs: 200_000,
  ikpu_code: '03004001001000000',
  package_code: '1501226',
  ...o,
});
const total = (d: { items: { price: number; count: number; discount?: number }[] }) => d.items.reduce((s, i) => s + i.price * i.count - (i.discount ?? 0), 0);

describe('Payme link', () => {
  it('base64 of m;ac.order_id;a (tiyin);l;c — sandbox or live by PAYME_TEST_MODE', () => {
    expect(paymeConfig({ PAYME_TEST_MODE: 'true' }).checkoutBase).toBe(PAYME_CHECKOUT_TEST);
    expect(paymeConfig({}).checkoutBase).toBe(PAYME_CHECKOUT_LIVE);
    const url = paymeCheckoutUrl({ merchantId: 'M1', checkoutBase: PAYME_CHECKOUT_TEST }, { orderNumber: 'VTL-20261103-0001', amountUzs: 255_000, lang: 'ru', returnUrl: 'https://t.me/shop_bot' });
    const [base, b64] = [url.slice(0, url.lastIndexOf('/')), url.slice(url.lastIndexOf('/') + 1)];
    expect(base).toBe(PAYME_CHECKOUT_TEST);
    expect(Buffer.from(b64, 'base64').toString()).toBe('m=M1;ac.order_id=VTL-20261103-0001;a=25500000;l=ru;c=https://t.me/shop_bot');
  });

  it('a bad VAT value falls back to 0', () => {
    expect(paymeConfig({ PAYME_VAT_PERCENT: 'abc' }).vatPercent).toBe(0);
    expect(paymeConfig({ PAYME_VAT_PERCENT: '12' }).vatPercent).toBe(12);
  });
});

describe('Payme receipt (detail)', () => {
  it('product lines + «Доставка»; the sum is the order total in tiyin', () => {
    const d = paymeReceipt({ total_uzs: 225_000, delivery_cost_uzs: 25_000, lines: [line()] }, cfg);
    expect(d.receipt_type).toBe(0);
    expect(d.items).toEqual([
      { title: 'Омега-3', price: 10_000_000, count: 2, code: '03004001001000000', package_code: '1501226', vat_percent: 12 },
      { title: 'Доставка', price: 2_500_000, count: 1, code: cfg.deliveryIkpu, package_code: cfg.deliveryPackageCode, vat_percent: 12 },
    ]);
    expect(total(d)).toBe(22_500_000);
  });

  it('a promo discount is the line discount; bonuses / rounding go into the biggest line; free delivery = no line', () => {
    const d = paymeReceipt(
      { total_uzs: 263_333, delivery_cost_uzs: 0, lines: [line({ paid_line_total_uzs: 180_000 }), line({ sku: 'B', qty: 1, unit_price_uzs: 90_000, line_total_uzs: 90_000, paid_line_total_uzs: 83_334 })] },
      cfg,
    );
    expect(d.items).toHaveLength(2);
    expect(total(d)).toBe(26_333_300);
    expect(d.items[0].discount).toBeGreaterThan(0);
  });

  it('gaps: products without ИКПУ or package code; a paid delivery without its codes', () => {
    expect(fiscalGaps({ delivery_cost_uzs: 0, lines: [line()] }, cfg).ok).toBe(true);
    expect(fiscalGaps({ delivery_cost_uzs: 0, lines: [line({ sku: 'X', ikpu_code: null }), line({ sku: 'Y', package_code: ' ' })] }, cfg).skus).toEqual(['X', 'Y']);
    expect(fiscalGaps({ delivery_cost_uzs: 25_000, lines: [line()] }, { deliveryIkpu: null, deliveryPackageCode: null })).toMatchObject({ delivery: true, ok: false });
    expect(fiscalGaps({ delivery_cost_uzs: 0, lines: [line()] }, { deliveryIkpu: null, deliveryPackageCode: null }).ok).toBe(true);
  });
});
