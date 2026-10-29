import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { formLabel, money, shortNameOf } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { track } from '../lib/analytics';
import type { OnlineProvider, ShortNamed } from '../lib/types';

export interface OrderItemLine extends ShortNamed {
  product_id: string;
  qty: number;
  line_total_uzs: number;
  image_url?: string | null;
  form?: string | null;
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
            {note?.(i)}
          </div>
          <strong className="order-item-price">{money(i.line_total_uzs, lang)}</strong>
        </li>
      ))}
    </ul>
  );
}

/** Goods, delivery («Бесплатно» as an accent, the first-order badge) and a big «Итого». delivery null = city not chosen. */
export function OrderTotals({ goods, goodsCount, delivery, firstOrder = false, total }: { goods: number; goodsCount?: number; delivery: number | null; firstOrder?: boolean; total: number }) {
  const { t, lang } = useI18n();
  return (
    <div className="order-totals">
      <div className="sum-row">
        <span>{goodsCount != null ? t('cart.goods', { n: goodsCount }) : t('order.goods')}</span>
        <span>{money(goods, lang)}</span>
      </div>
      {delivery != null && (
        <div className="sum-row">
          <span>
            {t('cart.delivery')}
            {firstOrder && <span className="first-order-badge">{t('order.firstOrder')}</span>}
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

const SOON_LOGOS: Record<OnlineProvider, { name: string; src: string }> = {
  payme: { name: 'Payme', src: '/payment/payme.png' },
  click: { name: 'Click', src: '/payment/click.png' },
  uzum: { name: 'Uzum', src: '/payment/uzum.png' },
};

/**
 * D-20: Payme / Click / Uzum in «Скоро». A tap does not choose the method: it opens a sheet explaining what works
 * now and counts payment_soon_click with the system name (Аналитика → Воронка).
 */
export function OnlineSoon({ systems }: { systems: OnlineProvider[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<OnlineProvider | null>(null);
  if (!systems.length) return null;
  return (
    <div className="online-soon">
      <div className="online-soon-row">
        {systems.map((s) => (
          <button
            key={s}
            type="button"
            className="online-soon-btn"
            aria-label={`${SOON_LOGOS[s].name} · ${t('pay.soon')}`}
            onClick={() => {
              setOpen(s);
              track('payment_soon_click', { system: s });
            }}
          >
            <img src={SOON_LOGOS[s].src} alt="" height={24} />
          </button>
        ))}
      </div>
      <p className="hint small">{t('pay.soonNote')}</p>
      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(null)}>
          <div className="sheet confirm-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" aria-hidden />
            <img className="online-soon-logo" src={SOON_LOGOS[open].src} alt={SOON_LOGOS[open].name} height={32} />
            <p className="confirm-text">{t('pay.soonSheet', { system: SOON_LOGOS[open].name })}</p>
            <div className="sheet-actions">
              <button type="button" className="btn btn-block" onClick={() => setOpen(null)} autoFocus>
                {t('pay.soonOk')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
