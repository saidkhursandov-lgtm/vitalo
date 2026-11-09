import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { money, orderNo, shortNameOf } from '../lib/format';
import { errorText, useI18n } from '../lib/i18n';
import { useOrder } from '../lib/queries';
import { openLink } from '../lib/telegram';
import type { OnlinePaymentStart, OnlineProvider } from '../lib/types';
import { CloseIcon } from './Icons';
import { PAY_LOGOS } from './PayMethods';

/** While the order waits, its status is asked again this often: Payme tells our server, not the Mini App. */
export const POLL_MS = 4000;

/**
 * Payme for one order: the page link is prepared before the tap (Telegram opens links only right inside the tap);
 * after the tap the order status is asked every few seconds until Payme has confirmed the payment to the server.
 */
export function usePaymeFlow(id: string) {
  const { lang } = useI18n();
  const [opened, setOpened] = useState(false);
  const order = useOrder(id);
  const o = order.data;
  const waiting = o?.status === 'awaiting_payment' && o.payment_status === 'payment_pending';
  const link = useQuery({
    queryKey: ['order', id, 'payme-link', lang],
    queryFn: () => api<OnlinePaymentStart>(`/payments/online/payme/orders/${id}/start`, { method: 'POST', body: { lang } }),
    enabled: waiting && o?.payment?.method === 'payme',
    staleTime: Infinity,
    retry: false,
  });
  useQuery({ queryKey: ['order', id, 'poll'], queryFn: () => order.refetch().then(() => true), enabled: waiting && opened, refetchInterval: POLL_MS });
  const pay = () => {
    if (!link.data) return;
    openLink(link.data.checkout_url);
    setOpened(true);
  };
  return {
    order,
    link,
    opened,
    pay,
    waiting,
    paid: o?.payment_status === 'payment_success',
    cancelled: o?.status === 'cancelled',
    linkError: link.isError ? errorText(lang, link.error instanceof ApiError ? link.error.code : undefined) : null,
  };
}

/** Seconds left until `until` (never below zero), ticking every second. */
export function useSecondsLeft(until: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  if (!until) return null;
  return Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
}

/** 1:05:09 / 29:41 */
export function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Lines shown in the receipt; the rest is «и ещё N». */
const RECEIPT_LINES = 3;

/**
 * 6а-Г (D-62): «Чек VITALO» — a sheet over the checkout right after «Оплатить» for an online payment (Payme; Click
 * when it is connected), with no screen in between: the order number, the booking timer, a short list of the goods,
 * the total and «Оплатить в Payme», which starts the payment at once. [✕] leads to the order: it is already placed.
 */
export function PayReceiptSheet({ orderId, provider, onClose }: { orderId: string; provider: OnlineProvider; onClose: () => void }) {
  const { t, lang } = useI18n();
  const flow = usePaymeFlow(orderId);
  const o = flow.order.data;
  const left = useSecondsLeft(flow.waiting ? o?.reserved_until : null);
  const name = PAY_LOGOS[provider].name;
  const items = o?.items ?? [];
  const more = items.length - RECEIPT_LINES;

  return (
    <div className="sheet-backdrop receipt-backdrop">
      <div className="sheet confirm-sheet receipt-sheet" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
        <div className="sheet-handle" aria-hidden />
        <div className="sheet-head">
          <h2 id="receipt-title">{t('pay.receiptTitle')}</h2>
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="sheet-body">
          {o && (
            <div className="receipt">
              <div className="receipt-row">
                <span className="hint">{t('pay.receiptOrder')}</span>
                <strong>{orderNo(o.order_number)}</strong>
              </div>
              {left !== null && (
                <p className={`receipt-timer ${left === 0 ? 'is-over' : ''}`} role="timer">
                  {left > 0 ? t('pay.reserveLeft', { time: clock(left) }) : t('pay.reserveOver')}
                </p>
              )}
              <ul className="receipt-items">
                {items.slice(0, RECEIPT_LINES).map((i) => (
                  <li key={i.product_id}>
                    <span className="receipt-item-name">{shortNameOf(i, lang)}</span>
                    <span className="receipt-item-qty">×{i.qty}</span>
                    <span className="receipt-item-sum">{money(i.line_total_uzs, lang)}</span>
                  </li>
                ))}
                {more > 0 && <li className="hint small">{t('pay.receiptMore', { n: more })}</li>}
              </ul>
              {o.totals.delivery_cost_uzs > 0 && (
                <div className="receipt-row small">
                  <span className="hint">{t('cart.delivery')}</span>
                  <span>{money(o.totals.delivery_cost_uzs, lang)}</span>
                </div>
              )}
              <div className="receipt-row receipt-total">
                <span>{t('pay.amount')}</span>
                <strong>{money(o.totals.total_uzs, lang)}</strong>
              </div>
            </div>
          )}
          {flow.paid ? (
            <div className="notice notice-ok" role="status">{t('pay.paid')}</div>
          ) : flow.cancelled ? (
            <div className="notice notice-error">{t('pay.cancelled')}</div>
          ) : flow.opened ? (
            <div className="notice notice-info" role="status">{t('pay.waitingSystem', { system: name })}</div>
          ) : null}
          {flow.linkError && <p className="error-text" role="alert">{flow.linkError}</p>}
        </div>
        <div className="sheet-actions sheet-actions-one">
          {flow.order.isPending ? (
            <button type="button" className="btn btn-block" disabled>
              {t('common.loading')}
            </button>
          ) : flow.waiting && !flow.paid ? (
            <button type="button" className={`btn btn-block ${flow.opened ? 'btn-secondary' : ''}`} disabled={!flow.link.data} onClick={flow.pay}>
              <img src={PAY_LOGOS[provider].src} alt="" height={20} aria-hidden />
              <span>{flow.link.isPending && !flow.opened ? t('common.loading') : t(flow.opened ? 'pay.payInAgain' : 'pay.payIn', { system: name })}</span>
            </button>
          ) : (
            <button type="button" className="btn btn-block" onClick={onClose}>
              {t('pay.toOrder')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
