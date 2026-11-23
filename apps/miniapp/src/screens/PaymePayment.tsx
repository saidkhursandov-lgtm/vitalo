import { Link, Navigate, useParams } from 'react-router-dom';
import { ErrorState, Loading, StickyAction } from '../components/ui';
import { PayBy } from '../components/PayBy';
import { usePaymeFlow, type PayProvider } from '../components/PayReceipt';
import { PAY_LOGOS } from '../components/PayMethods';
import { SupportButton } from '../components/Support';
import { money, orderNo } from '../lib/format';
import { useI18n } from '../lib/i18n';

/**
 * Payme: one button «Оплатить через Payme» opens Payme's page (through the Telegram adapter, inside the tap). The
 * customer pays there and comes back; meanwhile the screen asks for the order status and shows «Оплачен» as soon as
 * Payme has confirmed the payment to the server (PerformTransaction). 6а-Г: right after the checkout the same payment
 * opens as «Чек VITALO» over the checkout; this screen stays for the links from the order and the notifications.
 * Click works the same way (/orders/:id/click): its own texts and logo.
 */
export function PaymePayment({ provider = 'payme' }: { provider?: PayProvider }) {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const { order, link, opened, pay, waiting, paid, cancelled, linkError } = usePaymeFlow(id, provider);
  const k = (key: 'Title' | 'Waiting' | 'Step' | 'Again' | 'Button') => `pay.${provider}${key}` as const;

  if (order.isPending) return <div className="page"><Loading /></div>;
  if (order.isError) return <ErrorState error={order.error} onRetry={() => void order.refetch()} />;
  const d = order.data;
  // 6а-А: an order of another method (an old link) — the order screen shows the right way to pay
  if (d.payment?.method && d.payment.method !== provider) return <Navigate to={`/orders/${id}`} replace />;

  return (
    <div className="page">
      <h1>{t(k('Title'))}</h1>
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
            <div className="notice notice-info" role="status">{t(k('Waiting'))}</div>
          ) : (
            <p className="notice notice-info">{t(k('Step'))}</p>
          )}
          {linkError && (
            <p className="error-text" role="alert">
              {linkError}
            </p>
          )}
          <StickyAction>
            <button className={`btn btn-block ${opened ? 'btn-secondary' : ''}`} disabled={!link.data} onClick={pay}>
              <img src={PAY_LOGOS[provider].src} alt="" height={20} aria-hidden />
              <span>{link.isPending ? t('common.loading') : t(opened ? k('Again') : k('Button'))}</span>
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
