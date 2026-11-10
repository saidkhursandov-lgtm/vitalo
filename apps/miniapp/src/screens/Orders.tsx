import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ChevronIcon, OrdersIcon, STATUS_ICONS } from '../components/Icons';
import { EmptyState, ErrorState, Loading, StatusPill } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime, money, nameOf, orderNo, prettyPhone } from '../lib/format';
import { errorText, orderStatusKey, useI18n } from '../lib/i18n';
import { useOrder, useOrders, useShopTexts } from '../lib/queries';
import { daysText, payPath } from '../lib/shop';
import { haptic } from '../lib/telegram';
import { useConfirm } from '../components/Confirm';
import { useSheets } from '../components/Sheets';
import { SupportIcon } from '../components/Icons';
import { PayBy } from '../components/PayBy';
import { OrderItems, OrderTotals } from '../components/OrderItems';
import { IntakeGuideBlock } from '../components/OrderNotices';
import type { Order, OrderListItem } from '../lib/types';
import { UsaTracking, useUsaStageLabel } from '../components/CrossBorder';
import { PlaneIcon } from '../components/Icons';

/** The same status twice in a row (e.g. "new" -> "awaiting_payment" shown as "Ожидает оплаты" twice) is shown once. */
export function dedupeHistory<T extends { to_status: string }>(history: T[], label: (s: string) => string = (s) => s): T[] {
  return history.filter((h, i) => i === 0 || label(h.to_status) !== label(history[i - 1].to_status));
}

export function OrderRow({ order }: { order: OrderListItem }) {
  const { t, lang } = useI18n();
  const usaStage = useUsaStageLabel();
  const cb = order.status === 'paid' && order.cross_border_stage && order.cross_border_stage !== 'in_stock' ? order.cross_border_stage : null;
  return (
    <Link to={`/orders/${order.id}`} className="order-row">
      <div>
        <strong>{t('orders.number', { n: orderNo(order.order_number) })}</strong>
        <div className="hint small">
          {dateTime(order.created_at, lang)} · {t('orders.items', { n: order.items_count })}
        </div>
        {cb && (
          <div className="usa-row small">
            <PlaneIcon width={14} height={14} aria-hidden />
            {usaStage(cb, order.cross_border_from)}
          </div>
        )}
      </div>
      <div className="order-row-right">
        <StatusPill status={order.status} reported={order.payment_reported} cod={order.payment_method === 'cod'} />
        <strong>{money(order.total_uzs, lang)}</strong>
      </div>
      <ChevronIcon width={18} height={18} className="hint" />
    </Link>
  );
}

export function Orders() {
  const { t } = useI18n();
  const orders = useOrders();
  const items = orders.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="page">
      <h1>{t('orders.title')}</h1>
      {orders.isPending ? (
        <Loading variant="list" />
      ) : orders.isError ? (
        <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={OrdersIcon} title={t('orders.emptyTitle')} text={t('orders.empty')} action={<Link to="/catalog" className="btn">{t('common.toCatalog')}</Link>} />
      ) : (
        <div className="card list">
          {items.map((o) => (
            <OrderRow key={o.id} order={o} />
          ))}
          {orders.hasNextPage && (
            <button className="btn btn-secondary btn-block" onClick={() => void orders.fetchNextPage()}>
              {t('common.showMore')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Order detail: items, totals, address, status history; pay or cancel while unpaid. */
export function OrderDetail() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const client = useQueryClient();
  const confirm = useConfirm();
  const shop = useShopTexts();
  const order = useOrder(id);
  const cancel = useMutation({
    mutationFn: () => api<Order>(`/orders/${id}/cancel`, { method: 'POST', body: {} }),
    onSuccess: (o) => {
      haptic('success');
      client.setQueryData(['order', id], o);
      void client.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: () => haptic('error'),
  });

  if (order.isPending) return <div className="page"><Loading /><Loading /></div>;
  if (order.isError) return <ErrorState error={order.error} onRetry={() => void order.refetch()} />;
  const o = order.data;
  const unpaid = o.status === 'new' || o.status === 'awaiting_payment';
  const reported = !!o.payment?.customer_reported_paid_at;
  const cod = o.payment?.method === 'cod';
  // «Оплата при получении»: «Ожидает подтверждения» instead of «Ожидает оплаты» (status card and history)
  const stateLabel = (s: Order['status']) => t(orderStatusKey(s, { cod }));
  const term = daysText(o.delivery_eta?.min_days, o.delivery_eta?.max_days, shop.data?.delivery_days_label, lang);

  async function onCancel() {
    // a paid «под заказ» order: «деньги вернём»; payment on delivery (a local supplier) — nothing was paid
    const ok = await confirm({ message: t(o.status === 'paid' && !cod ? 'usa.cancelConfirm' : 'orders.cancelConfirm', { n: o.order_number }), ok: t('orders.cancelYes'), cancel: t('orders.cancelNo'), danger: true });
    if (ok) cancel.mutate();
  }

  return (
    <div className="page">
      <h1>{t('orders.number', { n: orderNo(o.order_number) })}</h1>
      <div className="order-status-hero">
        <StatusPill status={o.status} reported={reported} large cod={cod} />
        <span className="hint small">{dateTime(o.created_at, lang)}</span>
      </div>

      {cod && o.status === 'new' && <div className="notice notice-info">{t('orders.codWaiting')}</div>}
      {unpaid && o.reserved_until && !reported && <PayBy until={o.reserved_until} />}
      {unpaid && reported && <div className="notice notice-ok">{t('orders.payWaiting')}</div>}
      {/* D-60: «Где ваш заказ из США» — stages, dates, moved dates and when the money can be returned */}
      {o.cross_border && o.status !== 'cancelled' && <UsaTracking tracking={o.cross_border} cancel={o.cross_border_cancel} />}

      <section className="card summary">
        <OrderItems items={o.items} />
        <OrderTotals goods={o.totals.goods_list_total_uzs ?? o.totals.goods_total_uzs} campaigns={o.campaigns} discount={o.totals.discount_total_uzs} promo={o.promo} delivery={o.totals.delivery_cost_uzs} total={o.totals.total_uzs} />
      </section>

      {o.intake_guide && <IntakeGuideBlock guide={o.intake_guide} orderNumber={o.order_number} />}

      <section className="card">
        <h2>{t('orders.delivery')}</h2>
        <p>
          {nameOf(o.delivery.region, lang)}, {nameOf(o.delivery.city, lang)}
          <br />
          {o.delivery.address_text}
        </p>
        {/* D-60: while the jars are on their way from the USA the tracking above gives the date, not the courier term */}
        {term && (!o.cross_border || o.cross_border.stage === 'in_stock') && <p className="hint small">{t('delivery.term', { days: term })}</p>}
        <h2>{t('orders.recipient')}</h2>
        <p>
          {o.recipient.name}, {prettyPhone(o.recipient.phone)}
        </p>
      </section>

      <section className="card">
        <h2>{t('orders.history')}</h2>
        <ol className="timeline">
          {dedupeHistory(o.history, (s) => stateLabel(s as Order['status'])).map((h, i) => {
            const I = STATUS_ICONS[h.to_status];
            return (
              <li key={i}>
                <span className="timeline-icon" aria-hidden>
                  {I && <I width={14} height={14} />}
                </span>
                <strong>{stateLabel(h.to_status)}</strong>
                <span className="hint small">{dateTime(h.created_at, lang)}</span>
              </li>
            );
          })}
        </ol>
      </section>

      {cancel.isError && (
        <div className="notice notice-error">{errorText(lang, cancel.error instanceof ApiError ? cancel.error.code : undefined)}</div>
      )}
      {o.status === 'paid' && !o.cross_border && <p className="hint small">{t('orders.paidNoCancel')}</p>}
      {unpaid && reported && <p className="hint small">{t('orders.checkingNoCancel')}</p>}

      <div className="actions">
        {unpaid && !reported && (o.payment?.method === 'card_transfer' || o.payment?.method === 'bank_transfer' || o.payment?.method === 'payme') && (
          <Link to={payPath(o.id, o.payment?.method)} className="btn btn-block">
            {t('orders.pay')}
          </Link>
        )}
        {o.can_cancel && (
          <button className="btn btn-danger btn-block" disabled={cancel.isPending} onClick={() => void onCancel()}>
            {t('orders.cancel')}
          </button>
        )}
        {/* After "Я оплатил(а)" there is no cancel button: only support can cancel a payment being checked.
            6б-Б: a question about this order — a request with the order attached, inside the Mini App */}
        <OrderAsk order={{ id: o.id, number: o.order_number }} />
      </div>
    </div>
  );
}

function OrderAsk({ order }: { order: { id: string; number: string } }) {
  const { t } = useI18n();
  const { openAsk } = useSheets();
  return (
    <button type="button" className="btn btn-secondary btn-block" onClick={() => openAsk({ order, topic: 'order', source: 'order' })}>
      <SupportIcon width={20} height={20} /> {t('orders.ask')}
    </button>
  );
}
