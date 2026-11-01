import { Link } from 'react-router-dom';
import { track } from '../lib/analytics';
import { shownStatus, statusKey, useI18n } from '../lib/i18n';
import { useActiveOrder, useShopTexts } from '../lib/queries';
import { daysText } from '../lib/shop';
import { orderNo } from '../lib/format';
import type { IntakeGuide } from '../lib/types';
import { ChevronIcon, DoctorIcon, STATUS_ICONS } from './Icons';
import { useAskSpecialist } from './Support';

/**
 * 3.2: under the search on the home screen — «Заказ №… · статус · срок доставки» and «Подробнее ›» for the newest
 * unfinished order; «+N» when there are more; «Оплатить / Отправить чек» while the order waits for the transfer.
 * Nothing when the customer has no unfinished order.
 */
export function ActiveOrderBar() {
  const { t, lang } = useI18n();
  const active = useActiveOrder();
  const shop = useShopTexts();
  const o = active.data?.order;
  if (!o) return null;
  const cod = o.payment_method === 'cod';
  const status = cod && o.status === 'new' ? t('status.codWaiting') : t(statusKey(o.status, o.payment_reported));
  const term = daysText(o.delivery_eta?.min_days, o.delivery_eta?.max_days, shop.data?.delivery_days_label, lang);
  const I = STATUS_ICONS[shownStatus(o.status, o.payment_reported)];
  const more = active.data?.more ?? 0;

  return (
    <section className="active-order" aria-label={t('activeOrder.label', { n: o.order_number })}>
      <Link to={`/orders/${o.id}`} className="active-order-main" onClick={() => track('active_order_click', { order_id: o.id, action: 'open' })}>
        <span className="active-order-icon" aria-hidden>
          {I && <I width={20} height={20} />}
        </span>
        <span className="active-order-text">
          <span className="active-order-title">
            <strong>{t('activeOrder.label', { n: orderNo(o.order_number) })}</strong>
            {more > 0 && <span className="active-order-others">{t('activeOrder.others', { n: more })}</span>}
          </span>
          <span className="active-order-row">
            <span className="active-order-status">
              {status}
              {term && ` · ${t('activeOrder.term', { days: term })}`}
            </span>
            <span className="active-order-more">
              {t('activeOrder.more')}
              <ChevronIcon width={16} height={16} />
            </span>
          </span>
        </span>
      </Link>
      {o.can_pay && (
        <Link to={`/orders/${o.id}/pay`} className="btn btn-block active-order-pay" onClick={() => track('active_order_click', { order_id: o.id, action: 'pay' })}>
          {t('activeOrder.pay')}
        </Link>
      )}
    </section>
  );
}

/** 3.2: «Как принимать» in the order card — the same memo the bot sent after the payment; folded by default. */
export function IntakeGuideBlock({ guide, orderNumber }: { guide: IntakeGuide; orderNumber: string }) {
  const { t, lang } = useI18n();
  const ask = useAskSpecialist();
  const lines = guide[lang].length ? guide[lang] : guide.ru;
  return (
    <details className="card intake-guide">
      <summary>
        <h2>{t('intake.title')}</h2>
      </summary>
      <ul>
        {lines.map((g) => (
          <li key={g.product_id}>
            <strong>{g.name}</strong>
            <p>{g.text}</p>
          </li>
        ))}
      </ul>
      <p className="hint small">{guide.footer[lang]}</p>
      <button type="button" className="btn btn-secondary btn-block" onClick={() => ask(t('intake.askText', { n: orderNumber }))}>
        <DoctorIcon width={20} height={20} /> {t('ask.button')}
      </button>
    </details>
  );
}
