import { ConflictException } from '@nestjs/common';
import { assertTransition, canTransition, CUSTOMER_CANCELLABLE } from './order-state';

describe('order state machine', () => {
  it('follows the main path', () => {
    const path = ['new', 'awaiting_payment', 'paid', 'picking', 'handed_to_delivery', 'in_transit', 'delivered'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
  });

  it('forbids skipping payment and moving backwards', () => {
    expect(canTransition('awaiting_payment', 'picking')).toBe(false);
    expect(canTransition('paid', 'awaiting_payment')).toBe(false);
    expect(canTransition('delivered', 'cancelled')).toBe(false);
  });

  it('cancelled is final', () => {
    expect(canTransition('cancelled', 'awaiting_payment')).toBe(false);
    expect(() => assertTransition('cancelled', 'paid')).toThrow(ConflictException);
  });

  it('customers can self-cancel only unpaid orders', () => {
    expect(CUSTOMER_CANCELLABLE).toEqual(['new', 'awaiting_payment']);
  });
});
