import { ConflictException } from '@nestjs/common';
import type { OrderStatus } from '@prisma/client';

/**
 * Order state machine (Master TZ §11, Flow §15):
 * New -> Awaiting payment -> Paid -> Picking -> Handed to delivery -> In transit -> Delivered; + Cancelled, Return.
 * Payment status is a separate field and is not encoded here.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ['awaiting_payment', 'paid', 'cancelled'],
  awaiting_payment: ['paid', 'cancelled'],
  paid: ['picking', 'cancelled'], // cancelling a paid order: staff only (support)
  picking: ['handed_to_delivery', 'cancelled'],
  handed_to_delivery: ['in_transit', 'cancelled'], // after handover: only via a cancel request approved by a manager
  in_transit: ['delivered', 'cancelled'],
  delivered: ['return'],
  cancelled: [],
  return: [],
};

/**
 * Paid or confirmed by the manager and going to the customer (D-53: a cash-on-delivery order is here with its payment
 * still pending — the money comes with the courier).
 */
export const CONFIRMED_STATUSES: readonly OrderStatus[] = ['paid', 'picking', 'handed_to_delivery', 'in_transit', 'delivered'];

/** A customer may cancel on their own only while the order is unpaid. */
export const CUSTOMER_CANCELLABLE: readonly OrderStatus[] = ['new', 'awaiting_payment'];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException({ code: 'INVALID_STATUS_TRANSITION', message: `Cannot move order from ${from} to ${to}` });
  }
}
