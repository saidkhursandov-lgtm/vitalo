import { nameOf } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useAddresses, useDeliveryEta, useShopTexts } from '../lib/queries';
import { daysText } from '../lib/shop';
import type { CrossBorderWindow, Lang, ShopInfo } from '../lib/types';
import { dateRange, useUnderOrderText, windowMark } from './CrossBorder';

/** "г. Ташкент — 2–5 рабочих дней, регионы — 5–10 рабочих дней" from the tariffs; null if not set. */
export function generalTerms(shop: ShopInfo | undefined, lang: Lang, t: (k: 'delivery.terms', p: Record<string, string>) => string): string | null {
  if (!shop) return null;
  const { tashkent, regions } = shop.delivery_terms;
  const label = shop.delivery_days_label;
  const a = tashkent && daysText(tashkent.min_days, tashkent.max_days, label, lang);
  const b = regions && daysText(regions.min_days, regions.max_days, label, lang);
  return a && b ? t('delivery.terms', { tashkent: a, regions: b }) : a || b || null;
}

/** Delivery term for the customer's main address, or the general terms when there is none (product card). */
export function DeliveryTerm() {
  const { t, lang } = useI18n();
  const shop = useShopTexts();
  const primary = useAddresses().data?.find((a) => a.is_primary);
  const eta = useDeliveryEta(primary ? { region_id: primary.region.id, city_id: primary.city.id } : null);
  const own = eta.data && daysText(eta.data.min_days, eta.data.max_days, shop.data?.delivery_days_label, lang);
  if (primary && own) {
    return (
      <p>
        <strong>{nameOf(primary.city, lang)}</strong>: {t('delivery.term', { days: own })}
      </p>
    );
  }
  const general = generalTerms(shop.data, lang, t);
  return general ? <p>{general}</p> : null;
}

/** "Срок доставки: 2–5 рабочих дней" under the city choice (cart, checkout). */
export function QuoteTerm({ min, max, note }: { min?: number | null; max?: number | null; note?: string | null }) {
  const { t, lang } = useI18n();
  const shop = useShopTexts();
  const days = daysText(min, max, shop.data?.delivery_days_label, lang);
  if (!days) return null;
  return (
    <p className="term small">
      {t('delivery.term', { days })}
      {note && <span className="hint block">{note}</span>}
    </p>
  );
}

/**
 * 6а-Г (D-62): the delivery term of the cart and the checkout. An order with goods «из США» (or «под заказ») comes all
 * together, so instead of the shelf's «1–3 рабочих дня» it shows one expected window «16–23 ноября» — the same dates as
 * the notice and the order tracking.
 */
export function OrderTerm({ window: w, min, max, note }: { window?: CrossBorderWindow | null; min?: number | null; max?: number | null; note?: string | null }) {
  const { t, lang } = useI18n();
  const uo = useUnderOrderText();
  if (!w) return <QuoteTerm min={min} max={max} note={note} />;
  return (
    <p className="term small">
      {t('delivery.termDates', { dates: '' })}
      <span className="nowrap">{dateRange(w.expected_from, w.expected_to, lang)}</span>
      <span className="hint block">{uo('termNote', windowMark(w))}</span>
    </p>
  );
}
