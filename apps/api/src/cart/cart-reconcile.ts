export const MAX_LINE_QTY = 99;

export type CartWarning =
  | { code: 'price_changed'; product_id: string; old_price_uzs: number; new_price_uzs: number }
  // 3.7: «Акция завершилась» — the line was put in the cart at a sale price and the sale is over (or switched off)
  | { code: 'campaign_ended'; product_id: string; old_price_uzs: number; new_price_uzs: number; campaign_title_ru?: string; campaign_title_uz?: string | null }
  | { code: 'qty_reduced'; product_id: string; requested_qty: number; available_qty: number }
  | { code: 'out_of_stock'; product_id: string }
  // 3.3: the saved promo code stopped fitting the cart and was removed
  | { code: 'promo_removed'; product_id?: undefined; promo_code: string; reason: string; message_ru: string; message_uz: string };

export interface ReconcileInput {
  product_id: string;
  qty: number;
  snapshot_price_uzs: number;
  current_price_uzs: number;
  /** 3.7: the sale of the snapshot price and the sale running now (null = none) */
  snapshot_campaign_id?: string | null;
  current_campaign_id?: string | null;
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
 * - price changed: take the new price and warn (once: the caller stores the new snapshot); 3.7: when the old price
 *   was a sale price and that sale is not running any more, the warning is «Акция завершилась»;
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
      code: i.snapshot_campaign_id && i.snapshot_campaign_id !== i.current_campaign_id ? 'campaign_ended' : 'price_changed',
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
