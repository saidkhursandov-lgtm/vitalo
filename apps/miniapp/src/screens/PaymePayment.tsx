import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ErrorState, Loading, StickyAction } from '../components/ui';
import { PayBy } from '../components/PayBy';
import { SupportButton } from '../components/Support';
import { api, ApiError } from '../lib/api';
import { money, orderNo } from '../lib/format';
import { errorText, useI18n } from '../lib/i18n';
import { useOrder } from '../lib/queries';
import { openLink } from '../lib/telegram';
import type { OnlinePaymentStart } from '../lib/types';

/** While the order waits, its status is asked again this often: Payme tells our server, not the Mini App. */
const POLL_MS = 4000;

/**
 * Payme: one button «Оплатить через Payme» opens Payme's page (through the Telegram adapter, inside the tap). The
 * customer pays there and comes back; meanwhile the screen asks for the order status and shows «Оплачен» as soon as
 * Payme has confirmed the payment to the server (PerformTransaction).
 */
export function PaymePayment() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const [opened, setOpened] = useState(false);
  const order = useOrder(id);
  const o = order.data;
  const waiting = o?.status === 'awaiting_payment' && o.payment_status === 'payment_pending';
  // the page link is prepared before the tap: Telegram opens links only right inside the tap
  const link = useQuery({
    queryKey: ['order', id, 'payme-link', lang],
    queryFn: () => api<OnlinePaymentStart>(`/payments/online/payme/orders/${id}/start`, { method: 'POST', body: { lang } }),
    enabled: waiting,
    staleTime: Infinity,
    retry: false,
  });
  // polling: after the tap — every few seconds; and every time the customer comes back to the Mini App (focus)
  useQuery({ queryKey: ['order', id, 'poll'], queryFn: () => order.refetch().then(() => true), enabled: waiting && opened, refetchInterval: POLL_MS });

  if (order.isPending) return <div className="page"><Loading /></div>;
  if (order.isError) return <ErrorState error={order.error} onRetry={() => void order.refetch()} />;
  const d = o!;
  const paid = d.payment_status === 'payment_success';
  const cancelled = d.status === 'cancelled';

  const pay = () => {
    if (!link.data) return;
    openLink(link.data.checkout_url);
    setOpened(true);
  };

  return (
    <div className="page">
      <h1>{t('pay.paymeTitle')}</h1>
      <p className="hint">{t('orders.number', { n: orderNo(d.order_number) })}</p>

      <section className="card amount-card">
        <div className="hint small">{t('pay.amount')}</div>
        <div className="amount">{money(d.totals.total_uzs, lang)}</div>
      </section>

      {paid ? (
        <div className="notice notice-ok" role="status">{t('pay.paid')}</div>
      ) : cancelled ? (
        <div className="notice notice-error">{t('pay.cancelled')}</div>
      ) : waiting ? (
        <>
          {d.reserved_until && <PayBy until={d.reserved_until} />}
          {opened ? (
            <div className="notice notice-info" role="status">{t('pay.paymeWaiting')}</div>
          ) : (
            <p className="notice notice-info">{t('pay.paymeStep')}</p>
          )}
          {link.isError && (
            <p className="error-text" role="alert">
              {errorText(lang, link.error instanceof ApiError ? link.error.code : undefined)}
            </p>
          )}
          <StickyAction>
            <button className={`btn btn-block ${opened ? 'btn-secondary' : ''}`} disabled={!link.data} onClick={pay}>
              <img src="/payment/payme.png" alt="" height={20} aria-hidden />
              <span>{link.isPending ? t('common.loading') : t(opened ? 'pay.paymeAgain' : 'pay.paymeButton')}</span>
            </button>
          </StickyAction>
          <SupportButton className="btn btn-secondary btn-block" />
        </>
      ) : null}

      <Link to={`/orders/${id}`} className="btn btn-secondary btn-block">
        {t('pay.toOrder')}
      </Link>
    </div>
  );
}
