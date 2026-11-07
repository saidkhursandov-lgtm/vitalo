import type { PaymeConfig } from './payme-config';

/** One receipt line as Payme expects it in CheckPerformTransaction.detail (amounts in tiyin). */
export interface PaymeReceiptItem {
  title: string;
  price: number; // for one piece
  count: number;
  code: string; // ИКПУ (MXIK)
  package_code: string;
  vat_percent: number;
  discount?: number; // for the whole line
}

export interface PaymeReceiptDetail {
  receipt_type: 0;
  items: PaymeReceiptItem[];
}

export interface FiscalOrderLine {
  sku: string;
  title: string;
  qty: number;
  unit_price_uzs: number;
  line_total_uzs: number;
  paid_line_total_uzs: number;
  ikpu_code: string | null;
  package_code: string | null;
}

export interface FiscalOrder {
  total_uzs: number;
  delivery_cost_uzs: number;
  lines: FiscalOrderLine[];
}

const TITLE_MAX = 128;
const tiyin = (uzs: number) => Math.round(uzs * 100);

/** What is missing for a fiscal receipt: SKUs without ИКПУ / package code, and the delivery line's codes. */
export function fiscalGaps(order: Pick<FiscalOrder, 'delivery_cost_uzs' | 'lines'>, cfg: Pick<PaymeConfig, 'deliveryIkpu' | 'deliveryPackageCode'>) {
  const skus = order.lines.filter((l) => !l.ikpu_code?.trim() || !l.package_code?.trim()).map((l) => l.sku);
  const delivery = order.delivery_cost_uzs > 0 && (!cfg.deliveryIkpu || !cfg.deliveryPackageCode);
  return { skus, delivery, ok: skus.length === 0 && !delivery };
}

/**
 * The fiscal receipt of an order (receipt_type 0 = sale): a line per product at its list price with the line's
 * discount (promo, bonuses), then «Доставка». Σ(price × count − discount) is always exactly the order total in tiyin:
 * a rounding difference is put into the discount of the biggest line.
 */
export function paymeReceipt(order: FiscalOrder, cfg: Pick<PaymeConfig, 'deliveryIkpu' | 'deliveryPackageCode' | 'vatPercent'>): PaymeReceiptDetail {
  const items: PaymeReceiptItem[] = order.lines.map((l) => {
    const item: PaymeReceiptItem = {
      title: l.title.slice(0, TITLE_MAX),
      price: tiyin(l.unit_price_uzs),
      count: l.qty,
      code: l.ikpu_code!.trim(),
      package_code: l.package_code!.trim(),
      vat_percent: cfg.vatPercent,
    };
    const discount = tiyin(l.unit_price_uzs) * l.qty - tiyin(l.paid_line_total_uzs);
    if (discount > 0) item.discount = discount;
    return item;
  });

  const goods = tiyin(order.total_uzs) - tiyin(order.delivery_cost_uzs);
  const sum = items.reduce((s, i) => s + i.price * i.count - (i.discount ?? 0), 0);
  const diff = sum - goods; // > 0: the lines say more than the customer pays for goods (e.g. bonuses)
  if (diff !== 0 && items.length) {
    const biggest = items.reduce((a, b) => (b.price * b.count > a.price * a.count ? b : a));
    const discount = (biggest.discount ?? 0) + diff;
    if (discount > 0) biggest.discount = discount;
    else delete biggest.discount;
  }

  if (order.delivery_cost_uzs > 0) {
    items.push({
      title: 'Доставка',
      price: tiyin(order.delivery_cost_uzs),
      count: 1,
      code: cfg.deliveryIkpu!,
      package_code: cfg.deliveryPackageCode!,
      vat_percent: cfg.vatPercent,
    });
  }
  return { receipt_type: 0, items };
}
