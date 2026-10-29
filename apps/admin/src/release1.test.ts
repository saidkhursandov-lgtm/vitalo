import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION, discountAboveLimit, PAYMENT_METHOD } from './lib/format';

describe('release 1 labels', () => {
  it('payment method «При получении» and the audit line for the new settings', () => {
    expect(PAYMENT_METHOD.cod).toBe('При получении');
    expect(AUDIT_ACTION['settings.checkout_options_updated']).toMatch(/оплаты/);
  });

  it('D-09: the product form warns about a discount above 25% only', () => {
    expect(discountAboveLimit(75_000, 100_000)).toBeNull(); // exactly 25%
    expect(discountAboveLimit(74_000, 100_000)).toBe(26);
    expect(discountAboveLimit(30_000, 100_000)).toBe(70);
    expect(discountAboveLimit(100_000, 100_000)).toBeNull(); // no discount
    expect(discountAboveLimit(120_000, 100_000)).toBeNull(); // the old price is lower
    expect(discountAboveLimit(50_000, undefined)).toBeNull(); // no old price
    expect(discountAboveLimit(undefined, 100_000)).toBeNull();
  });
});
