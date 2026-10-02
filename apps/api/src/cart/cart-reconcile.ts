export const MAX_LINE_QTY = 99;

export type CartWarning =
  | { code: 'price_changed'; product_id: string; old_price_uzs: number; new_price_uzs: number }
  | { code: 'qty_reduced'; product_id: string; requested_qty: number; available_qty: number }
  | { code: 'out_of_stock'; product_id: string };

export interface ReconcileInput {
  product_id: string;
  qty: number;
  snapshot_price_uzs: number;
  current_price_uzs: number;
  sellable: boolean; // product is active
  available_qty: number;
}

export interface ReconcileResult {
  status: 'available' | 'unavailable';
  qty: number;
  unit_price_uzs: number;
  warnings: CartWarning[];
}

/**
 * Master TZ §6/§16: on every cart open the line is checked against the current price and stock.
 * - price changed: take the new price and warn (once: the caller stores the new snapshot);
 * - qty above stock: reduce to what is available and warn;
 * - no stock / product not sold anymore: the line stays in the cart as unavailable (not checkout-able).
 */
export function reconcileCartLine(i: ReconcileInput): ReconcileResult {
  if (!i.sellable || i.available_qty <= 0) {
    return {
      status: 'unavailable',
      qty: i.qty,
      unit_price_uzs: i.current_price_uzs,
      warnings: [{ code: 'out_of_stock', product_id: i.product_id }],
    };
  }

  const warnings: CartWarning[] = [];
  if (i.current_price_uzs !== i.snapshot_price_uzs) {
    warnings.push({
      code: 'price_changed',
      product_id: i.product_id,
      old_price_uzs: i.snapshot_price_uzs,
      new_price_uzs: i.current_price_uzs,
    });
  }
  const limit = Math.min(i.available_qty, MAX_LINE_QTY);
  if (i.qty > limit) {
    warnings.push({ code: 'qty_reduced', product_id: i.product_id, requested_qty: i.qty, available_qty: limit });
  }
  return { status: 'available', qty: Math.min(i.qty, limit), unit_price_uzs: i.current_price_uzs, warnings };
}
