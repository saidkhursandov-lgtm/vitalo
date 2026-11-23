import type { PaymeConfig } from '../payme/payme-config';
import { paymeReceipt, type FiscalOrder } from '../payme/payme-fiscal';

/** One line of Click's fiscal data (Merchant API ofd_data/submit_items). Money in tiyin. */
export interface ClickFiscalItem {
  Name: string;
  SPIC: string; // ИКПУ (MXIK)
  PackageCode: string;
  GoodPrice: number; // for one piece
  Price: number; // the whole line before Discount
  Amount: number;
  Discount?: number;
  VAT: number; // the VAT inside the line, tiyin
  VATPercent: number;
  CommissionInfo?: { TIN: string };
}

export interface ClickFiscalBody {
  service_id: number;
  payment_id: number;
  items: ClickFiscalItem[];
  received_ecash: number;
  received_cash: number;
  received_card: number;
}

const NAME_MAX = 63;

/**
 * The same receipt as for Payme (one line per product at its list price with the line's discount, then «Доставка»;
 * Σ(Price − Discount) is exactly the order total), in Click's field names. The whole sum is paid by card.
 */
export function clickFiscalItems(
  order: FiscalOrder,
  cfg: Pick<PaymeConfig, 'deliveryIkpu' | 'deliveryPackageCode' | 'vatPercent'>,
  tin: string | null,
): { items: ClickFiscalItem[]; total: number } {
  const receipt = paymeReceipt(order, cfg);
  const items = receipt.items.map((i): ClickFiscalItem => {
    const price = i.price * i.count;
    const paid = price - (i.discount ?? 0);
    const item: ClickFiscalItem = {
      Name: i.title.slice(0, NAME_MAX),
      SPIC: i.code,
      PackageCode: i.package_code,
      GoodPrice: i.price,
      Price: price,
      Amount: i.count,
      VAT: Math.round((paid * i.vat_percent) / (100 + i.vat_percent)),
      VATPercent: i.vat_percent,
    };
    if (i.discount) item.Discount = i.discount;
    if (tin) item.CommissionInfo = { TIN: tin };
    return item;
  });
  return { items, total: items.reduce((s, i) => s + i.Price - (i.Discount ?? 0), 0) };
}
