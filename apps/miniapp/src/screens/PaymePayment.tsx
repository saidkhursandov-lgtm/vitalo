import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ErrorState, Loading, StickyAction } from '../components/ui';
import { PayBy } from '../components/PayBy';
import { isPayProvider, NotOpened, usePaymeFlow } from '../components/PayReceipt';
import { PAY_LOGOS, PayMethods, type PayCard } from '../components/PayMethods';
import { SupportButton } from '../components/Support';
import { api, ApiError } from '../lib/api';
import { money, orderNo } from '../lib/format';
import { errorText, useI18n } from '../lib/i18n';
import { useOrder } from '../lib/queries';
import type { Order, PaymentChoices, PaymentMethodCode } from '../lib/types';

/**
 * «Оплата заказа» (/orders/:id/payment; the old /payme and /click links open it too): the amount, the booking
 * deadline, the chosen way to pay and the button. While the order is unpaid the customer can pick another way —
 * Payme, Click, Uzum or a card transfer, only those open for them now; the amount and the booking stay the same.
 * An online system: «Оплатить через Payme» opens its page (prepared before the tap; through the Telegram adapter,
 * in the phone browser, so the Payme / Click app can take over); the screen then asks for the order status and shows
 * «Оплачен» as soon as the system has confirmed the payment to the server. A card transfer: the requisites screen.
 */
export function PaymePayment() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const order = useOrder(id);
  // the order itself says how it is paid now; the list of other ways comes separately (not needed to pay)
  const current = order.data?.payment?.method ?? null;
  const provider = isPayProvider(current) ? current : null;
  const flow = usePaymeFlow(id, provider);
  const choices = useQuery({
    queryKey: ['order', id, 'pay-methods'],
    queryFn: () => api<PaymentChoices>(`/payments/online/orders/${id}/methods`),
    enabled: flow.waiting,
  });
  const change = useMutation({
    mutationFn: (method: PaymentMethodCode) => api<PaymentChoices>(`/payments/online/orders/${id}/method`, { method: 'POST', body: { method } }),
    onSuccess: (next) => {
      qc.setQueryData(['order', id, 'pay-methods'], next);
      qc.setQueryData<Order>(['order', id], (o) => (o?.payment ? { ...o, payment: { ...o.payment, method: next.current ?? o.payment.method } } : o));
      void qc.invalidateQueries({ queryKey: ['order', id], exact: true });
      // the old way's prepared link and requisites are stale: asked again only if the customer comes back to them
      qc.removeQueries({ queryKey: ['order', id], predicate: (q) => q.queryKey[2] === 'bank-transfer' || String(q.queryKey[2]).endsWith('-link') });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  if (order.isPending) return <div className="page"><Loading /></div>;
  if (order.isError) return <ErrorState error={order.error} onRetry={() => void order.refetch()} />;
  const d = order.data;
  const blocked = choices.data?.blocked ?? null;
  const methods = Array.isArray(choices.data?.methods) ? choices.data.methods : [];
  // cash on delivery has nothing to pay here; «Я оплатил(а)» was pressed — the transfer screen shows its check
  if (current === 'cod') return <Navigate to={`/orders/${id}`} replace />;
  if (blocked === 'reported' || d.payment?.customer_reported_paid_at) return <Navigate to={`/orders/${id}/pay`} replace />;

  const name = provider ? PAY_LOGOS[provider].name : '';
  const canChange = flow.waiting && !blocked && !flow.paid && methods.length > 1;
  const cards: PayCard[] = methods.map((m) => ({
    code: m.code,
    state: m.unavailable ? 'disabled' : 'ok',
    desc: m.unavailable && isPayProvider(m.code) ? t('pay.ikpuVia', { system: PAY_LOGOS[m.code].name }) : '',
  }));
  const changeError = change.isError ? errorText(lang, change.error instanceof ApiError ? change.error.code : undefined) : null;

  return (
    <div className="page">
      <h1>{t('pay.screenTitle')}</h1>
      <p className="hint">{t('orders.number', { n: orderNo(d.order_number) })}</p>

      <section className="card amount-card">
        <div className="hint small">{t('pay.amount')}</div>
        <div className="amount">{money(d.totals.total_uzs, lang)}</div>
      </section>

      {flow.paid ? (
        <div className="notice notice-ok" role="status">{t('pay.paid')}</div>
      ) : flow.cancelled ? (
        <div className="notice notice-error">{t('pay.cancelled')}</div>
      ) : flow.waiting ? (
        <>
          {d.reserved_until && <PayBy until={d.reserved_until} />}

          {canChange && (
            <section className="card pay-method-card" aria-busy={change.isPending}>
              <h2 className="pay-method-title">{t('pay.methodTitle')}</h2>
              <PayMethods cards={cards} value={change.isPending ? (change.variables ?? current ?? '') : (current ?? '')} onChange={(m) => m !== current && !change.isPending && change.mutate(m)} />
              <p className="hint small">{change.isPending ? t('pay.changing') : t('pay.methodHint')}</p>
              {changeError && <p className="error-text" role="alert">{changeError}</p>}
            </section>
          )}

          {provider ? (
            <>
              {flow.opened ? (
                <>
                  <div className="notice notice-info" role="status">{t('pay.waitingVia', { system: name })}</div>
                  <NotOpened copied={flow.copied} onCopy={flow.copy} />
                </>
              ) : (
                <p className="notice notice-info">{t('pay.stepVia', { system: name })}</p>
              )}
              {flow.linkError && (
                <p className="error-text" role="alert">
                  {flow.linkError}
                </p>
              )}
              <StickyAction>
                <button className={`btn btn-block ${flow.opened ? 'btn-secondary' : ''}`} disabled={!flow.link.data || change.isPending} onClick={flow.pay}>
                  <img src={PAY_LOGOS[provider].src} alt="" height={20} aria-hidden />
                  <span>{flow.link.isPending || change.isPending ? t('common.loading') : t(flow.opened ? 'pay.payInAgain' : 'pay.payVia', { system: name })}</span>
                </button>
              </StickyAction>
            </>
          ) : (
            <StickyAction>
              <Link to={`/orders/${id}/pay`} className={`btn btn-block ${change.isPending ? 'is-disabled' : ''}`} aria-disabled={change.isPending}>
                {t('pay.toCardDetails')}
              </Link>
            </StickyAction>
          )}
          <SupportButton className="btn btn-secondary btn-block" />
        </>
      ) : null}

      <Link to={`/orders/${id}`} className="btn btn-secondary btn-block">
        {t('pay.toOrder')}
      </Link>
    </div>
  );
}
