import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { formLabel, money, shortNameOf } from '../lib/format';
import { useI18n } from '../lib/i18n';
import type { CampaignLine, ShortNamed, UnderOrderMark } from '../lib/types';
import { CampaignRows } from './Campaign';
import { UsaBadge } from './CrossBorder';

export interface OrderItemLine extends ShortNamed {
  product_id: string;
  qty: number;
  line_total_uzs: number;
  image_url?: string | null;
  form?: string | null;
  /** D-60: «Из США»; D-61: or «Под заказ» (a local supplier) */
  cross_border?: boolean;
  under_order?: UnderOrderMark | null;
}

/**
 * «Ваш заказ» (2.1): the same list in the checkout and in the order card. Photo, short name in up to 2 lines,
 * «× 1 · капсулы» below, the price on the right.
 */
export function OrderItems({ items, note }: { items: OrderItemLine[]; note?: (item: OrderItemLine) => ReactNode }) {
  const { lang } = useI18n();
  return (
    <ul className="order-items">
      {items.map((i) => (
        <li key={i.product_id} className="order-item">
          <Link to={`/product/${i.product_id}`} className="order-item-img" tabIndex={-1} aria-hidden>
            {i.image_url && <img src={i.image_url} alt="" width={48} height={48} loading="lazy" decoding="async" />}
          </Link>
          <div className="order-item-info">
            <Link to={`/product/${i.product_id}`} className="order-item-name">
              {shortNameOf(i, lang)}
            </Link>
            <span className="hint small">
              × {i.qty}
              {i.form && ` · ${formLabel(i.form, lang)}`}
            </span>
            {i.cross_border && <UsaBadge mark={i.under_order} />}
            {note?.(i)}
          </div>
          <strong className="order-item-price">{money(i.line_total_uzs, lang)}</strong>
        </li>
      ))}
    </ul>
  );
}

/**
 * Goods, the promo discount as its own line (3.3), delivery («Бесплатно» as an accent, the first-order or promo badge)
 * and a big «Итого». delivery null = city not chosen. `goods` is before the discount.
 */
export function OrderTotals({ goods, goodsCount, discount = 0, promo, bonus = 0, delivery, firstOrder = false, total, campaigns, saleHint = false }: {
  /** 3.7: at regular prices when there are sale lines (they follow it) */
  goods: number;
  goodsCount?: number;
  discount?: number;
  promo?: { code: string; free_delivery: boolean } | null;
  /** 3.10-А: bonuses spent on the order */
  bonus?: number;
  delivery: number | null;
  firstOrder?: boolean;
  total: number;
  /** 3.7: «Акция «11.11»: −X сум» */
  campaigns?: CampaignLine[];
  /** 3.7: a promo code is on, but some products are in a sale above 15% — it does not apply to them */
  saleHint?: boolean;
}) {
  const { t, lang } = useI18n();
  return (
    <div className="order-totals">
      <div className="sum-row">
        <span>{goodsCount != null ? t('cart.goods', { n: goodsCount }) : t('order.goods')}</span>
        <span>{money(goods, lang)}</span>
      </div>
      <CampaignRows campaigns={campaigns} />
      {discount > 0 && (
        <div className="sum-row promo-row">
          <span>{promo ? t('promo.line', { code: promo.code }) : t('promo.label')}</span>
          <span className="promo-amount">−{money(discount, lang)}</span>
        </div>
      )}
      {saleHint && <p className="hint small sale-hint">{t('promo.saleHint')}</p>}
      {bonus > 0 && (
        <div className="sum-row promo-row">
          <span>{t('bonus.line')}</span>
          <span className="promo-amount">−{money(bonus, lang)}</span>
        </div>
      )}
      {delivery != null && (
        <div className="sum-row">
          <span>
            {t('cart.delivery')}
            {firstOrder && <span className="first-order-badge">{t('order.firstOrder')}</span>}
            {!firstOrder && promo?.free_delivery && delivery === 0 && <span className="first-order-badge">{t('promo.badge')} {promo.code}</span>}
          </span>
          {delivery === 0 ? <span className="free-accent">{t('cart.free')}</span> : <span>{money(delivery, lang)}</span>}
        </div>
      )}
      <div className="sum-row total">
        <span>{t('cart.total')}</span>
        <span>{money(total, lang)}</span>
      </div>
    </div>
  );
}
