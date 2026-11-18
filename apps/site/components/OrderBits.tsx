'use client';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { dateTime, money, orderNo } from '@/lib/format';
import type { OrderListItem, OrderStatus } from '@/lib/types';
import { useSession } from './Session';

const TONE: Partial<Record<OrderStatus, string>> = { awaiting_payment: 'warn', cancelled: 'muted', return: 'muted', delivered: 'ok', paid: 'ok' };

/** The order status as a coloured badge; «Я оплатил(а)» pressed — «Проверяем оплату» instead of «Ждёт оплаты». */
export function StatusBadge({ status, reported }: { status: OrderStatus; reported?: boolean }) {
  const { t } = useSession();
  const checking = status === 'awaiting_payment' && reported;
  return <span className={`status-badge is-${checking ? 'info' : (TONE[status] ?? 'info')}`}>{checking ? t('acc.checking') : t(`status.${status}`)}</span>;
}

export function OrderRow({ order }: { order: OrderListItem }) {
  const { t, lang } = useSession();
  return (
    <Link href={`/order/${order.id}`} className="order-row">
      <span className="order-row-main">
        <b>{t('orders.number', { n: orderNo(order.order_number) })}</b>
        <span className="hint">
          {dateTime(order.created_at, lang)} · {t('orders.items', { n: order.items_count })}
        </span>
      </span>
      <span className="order-row-side">
        <StatusBadge status={order.status} reported={order.payment_reported} />
        <b>{money(order.total_uzs, lang)}</b>
      </span>
      <ChevronRight size={18} strokeWidth={1.8} className="order-row-go" />
    </Link>
  );
}
