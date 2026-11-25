import { createHash } from 'crypto';
import { clickAmount, clickConfig, clickMerchantAuth, clickPayUrl, clickSign, clickSignValid, CLICK_API_DEFAULT } from './click-config';
import { clickFiscalItems } from './click-fiscal';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

describe('Click signature (SHOP API)', () => {
  const prep = { click_trans_id: '123', service_id: '77', merchant_trans_id: '202611030001', amount: '255000.00', action: '0', sign_time: '2026-11-23 12:00:00' };

  it('Prepare: md5(click_trans_id + service_id + SECRET + merchant_trans_id + amount + action + sign_time)', () => {
    expect(clickSign(prep, 'S')).toBe(md5('12377S202611030001255000.0002026-11-23 12:00:00'));
  });

  it('Complete: merchant_prepare_id goes after merchant_trans_id', () => {
    const c = { ...prep, action: '1', merchant_prepare_id: '9' };
    expect(clickSign(c, 'S')).toBe(md5('12377S2026110300019255000.0012026-11-23 12:00:00'));
  });

  it('valid only with the right key; any case; no key in .env = never valid', () => {
    const sign = clickSign(prep, 'S');
    expect(clickSignValid(prep, sign, 'S')).toBe(true);
    expect(clickSignValid(prep, sign.toUpperCase(), 'S')).toBe(true);
    expect(clickSignValid(prep, sign, 'other')).toBe(false);
    expect(clickSignValid(prep, sign, '')).toBe(false);
    expect(clickSignValid(prep, 'not-a-hash', 'S')).toBe(false);
  });
});

describe('Click link and Merchant API', () => {
  it('my.click.uz/services/pay/ with service, merchant, amount N.NN, the order digits and return_url', () => {
    const url = new URL(clickPayUrl({ serviceId: '77', merchantId: '55' }, { orderNumber: 'VTL-20261103-0001', amountUzs: 255_000, returnUrl: 'https://t.me/shop_bot' }));
    expect(url.origin + url.pathname).toBe('https://my.click.uz/services/pay/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      service_id: '77',
      merchant_id: '55',
      amount: '255000.00',
      transaction_param: '202611030001',
      return_url: 'https://t.me/shop_bot',
    });
    expect(clickAmount(1000)).toBe('1000.00');
  });

  it('Auth: merchant_user_id:sha1(timestamp + secret):timestamp', () => {
    const at = 1_763_900_000_000;
    const ts = Math.floor(at / 1000);
    expect(clickMerchantAuth({ merchantUserId: '33', secretKey: 'S' }, at)).toBe(`33:${createHash('sha1').update(`${ts}S`).digest('hex')}:${ts}`);
  });

  it('config from .env, default API address', () => {
    expect(clickConfig({ CLICK_SERVICE_ID: ' 77 ' })).toMatchObject({ serviceId: '77', apiBase: CLICK_API_DEFAULT, fiscalTin: null });
  });
});

describe('Click fiscal items', () => {
  const line = { sku: 'A', title: 'Омега-3', qty: 2, unit_price_uzs: 100_000, line_total_uzs: 200_000, paid_line_total_uzs: 180_000, ikpu_code: '03004001001000000', package_code: '1501226' };
  const cfg = { deliveryIkpu: '10112006002000000', deliveryPackageCode: '1209885', vatPercent: 12 };

  it('a line per product + «Доставка» in tiyin; Σ(Price − Discount) = the order total; VAT inside the paid sum', () => {
    const { items, total } = clickFiscalItems({ total_uzs: 205_000, delivery_cost_uzs: 25_000, lines: [line] }, cfg, '123456789');
    expect(items[0]).toEqual({
      Name: 'Омега-3',
      SPIC: '03004001001000000',
      PackageCode: '1501226',
      GoodPrice: 10_000_000,
      Price: 20_000_000,
      Amount: 2,
      Discount: 2_000_000,
      VAT: Math.round((18_000_000 * 12) / 112),
      VATPercent: 12,
      CommissionInfo: { TIN: '123456789' },
    });
    expect(items[1]).toMatchObject({ Name: 'Доставка', SPIC: cfg.deliveryIkpu, Price: 2_500_000, Amount: 1 });
    expect(total).toBe(20_500_000);
  });

  it('VAT 0 and no TIN: VAT 0, no CommissionInfo', () => {
    const { items } = clickFiscalItems({ total_uzs: 180_000, delivery_cost_uzs: 0, lines: [line] }, { ...cfg, vatPercent: 0 }, null);
    expect(items[0]).toMatchObject({ VAT: 0, VATPercent: 0 });
    expect(items[0].CommissionInfo).toBeUndefined();
  });
});
