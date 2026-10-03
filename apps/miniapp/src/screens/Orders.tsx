import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ChevronIcon } from '../components/Icons';
import { EmptyState, ErrorState, Loading } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime, money, nameOf, prettyPhone } from '../lib/format';
import { errorText, statusKey, useI18n } from '../lib/i18n';
import { useOrder, useOrders } from '../lib/queries';
import { confirmDialog, haptic } from '../lib/telegram';
import type { Order, OrderListItem } from '../lib/types';

/** Colored status; "Я оплатил(а)" pressed but not confirmed yet = "🔵 Оплата проверяется". */
export function StatusChip({ status, reported = false, large = false }: { status: OrderListItem['status']; reported?: boolean; large?: boolean }) {
  const { t } = useI18n();
  const shown = reported && (status === 'awaiting_payment' || status === 'new') ? 'checking' : status;
  return <span className={`status status-${shown}${large ? ' status-lg' : ''}`}>{t(statusKey(status, reported))}</span>;
}

export function OrderRow({ order }: { order: OrderListItem }) {
  const { t, lang } = useI18n();
  return (
    <Link to={`/orders/${order.id}`} className="order-row">
      <div>
        <strong>{t('orders.number', { n: order.order_number })}</strong>
        <div className="hint small">
          {dateTime(order.created_at, lang)} · {t('orders.items', { n: order.items_count })}
        </div>
      </div>
      <div className="order-row-right">
        <StatusChip status={order.status} reported={order.payment_reported} />
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
        <Loading />
      ) : orders.isError ? (
        <ErrorState error={orders.error} onRetry={() => void orders.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={t('orders.emptyTitle')} text={t('orders.empty')} action={<Link to="/catalog" className="btn">{t('common.toCatalog')}</Link>} />
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

  if (order.isPending) return <Loading />;
  if (order.isError) return <ErrorState error={order.error} onRetry={() => void order.refetch()} />;
  const o = order.data;
  const unpaid = o.status === 'new' || o.status === 'awaiting_payment';
  const reported = !!o.payment?.customer_reported_paid_at;

  async function onCancel() {
    if (await confirmDialog(t('orders.cancelConfirm', { n: o.order_number }))) cancel.mutate();
  }

  return (
    <div className="page">
      <h1>{t('orders.number', { n: o.order_number })}</h1>
      <div className="order-status-hero">
        <StatusChip status={o.status} reported={reported} large />
        <span className="hint small">{dateTime(o.created_at, lang)}</span>
      </div>

      {unpaid && o.reserved_until && !reported && <p className="small">{t('orders.payUntil', { date: dateTime(o.reserved_until, lang) })}</p>}
      {unpaid && reported && <div className="notice notice-ok">{t('orders.payWaiting')}</div>}

      <section className="card summary">
        {o.items.map((i) => (
          <div key={i.product_id} className="sum-row">
            <Link to={`/product/${i.product_id}`}>
              {i.name_ru} × {i.qty}
            </Link>
            <span>{money(i.line_total_uzs, lang)}</span>
          </div>
        ))}
        <div className="sum-row">
          <span>{t('cart.delivery')}</span>
          <span>{o.totals.delivery_cost_uzs ? money(o.totals.delivery_cost_uzs, lang) : t('cart.free')}</span>
        </div>
        <div className="sum-row total">
          <span>{t('cart.total')}</span>
          <span>{money(o.totals.total_uzs, lang)}</span>
        </div>
      </section>

      <section className="card">
        <h2>{t('orders.delivery')}</h2>
        <p>
          {nameOf(o.delivery.region, lang)}, {nameOf(o.delivery.city, lang)}
          <br />
          {o.delivery.address_text}
        </p>
        <h2>{t('orders.recipient')}</h2>
        <p>
          {o.recipient.name}, {prettyPhone(o.recipient.phone)}
        </p>
      </section>

      <section className="card">
        <h2>{t('orders.history')}</h2>
        <ol className="timeline">
          {o.history.map((h, i) => (
            <li key={i}>
              <strong>{t(statusKey(h.to_status))}</strong>
              <span className="hint small">{dateTime(h.created_at, lang)}</span>
            </li>
          ))}
        </ol>
      </section>

      {cancel.isError && (
        <div className="notice notice-error">{errorText(lang, cancel.error instanceof ApiError ? cancel.error.code : undefined)}</div>
      )}
      {o.status === 'paid' && <p className="hint small">{t('orders.paidNoCancel')}</p>}

      <div className="actions">
        {unpaid && !reported && (o.payment?.method === 'card_transfer' || o.payment?.method === 'bank_transfer') && (
          <Link to={`/orders/${o.id}/pay`} className="btn btn-block">
            {t('orders.pay')}
          </Link>
        )}
        {o.can_cancel && (
          <button className="btn btn-danger btn-block" disabled={cancel.isPending} onClick={() => void onCancel()}>
            {t('orders.cancel')}
          </button>
        )}
      </div>
    </div>
  );
}
