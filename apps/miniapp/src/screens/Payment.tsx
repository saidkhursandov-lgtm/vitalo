import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CopyIcon } from '../components/Icons';
import { ErrorState, Loading } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime, money } from '../lib/format';
import { errorText, useI18n, type MessageKey } from '../lib/i18n';
import { useBankTransfer } from '../lib/queries';
import { haptic } from '../lib/telegram';

function CopyRow({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-row">
      <div>
        <div className="hint small">{label}</div>
        <div className="copy-value">{value}</div>
      </div>
      <button
        type="button"
        className="icon-btn"
        aria-label={copied ? t('pay.copied') : t('pay.copy')}
        onClick={() =>
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <span className="small">✓</span> : <CopyIcon width={20} height={20} />}
      </button>
    </div>
  );
}

/** Bank transfer: requisites from admin settings + "Я оплатил" (then a manager confirms). */
export function Payment() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const client = useQueryClient();
  const details = useBankTransfer(id);
  const reportPaid = useMutation({
    mutationFn: () => api(`/orders/${id}/payment/bank-transfer/paid`, { method: 'POST', body: {} }),
    onSuccess: () => {
      haptic('success');
      void client.invalidateQueries({ queryKey: ['order', id] });
      void client.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: () => haptic('error'),
  });

  if (details.isPending) return <Loading />;
  if (details.isError) return <ErrorState error={details.error} onRetry={() => void details.refetch()} />;
  const d = details.data;

  const paid = d.payment_status === 'payment_success';
  const cancelled = d.status === 'cancelled';
  const reported = !!d.customer_reported_paid_at;
  const r = d.requisites;
  const fields: [MessageKey, string][] = [
    ['pay.recipient', r.recipient],
    ['pay.bank', r.bank_name],
    ['pay.account', r.account],
    ['pay.mfo', r.mfo],
    ['pay.inn', r.inn],
    ['pay.purpose', d.purpose],
  ];

  return (
    <div className="page">
      <h1>{t('pay.title')}</h1>
      <p className="hint">{t('orders.number', { n: d.order_number })}</p>

      <section className="card amount-card">
        <div className="hint small">{t('pay.amount')}</div>
        <div className="amount">{money(d.amount_uzs, lang)}</div>
        {!paid && !cancelled && d.pay_until && <p className="small">{t('pay.until', { date: dateTime(d.pay_until, lang) })}</p>}
      </section>

      {paid ? (
        <div className="notice notice-ok">{t('pay.paid')}</div>
      ) : cancelled ? (
        <div className="notice notice-error">{t('pay.cancelled')}</div>
      ) : (
        <>
          <section className="card">
            {fields.map(([label, value]) => (
              <CopyRow key={label} label={t(label)} value={value} />
            ))}
          </section>

          {reported || reportPaid.isSuccess ? (
            <div className="notice notice-ok">{t('pay.waiting')}</div>
          ) : (
            <div className="sticky-action">
              {reportPaid.isError && (
                <p className="error-text">{errorText(lang, reportPaid.error instanceof ApiError ? reportPaid.error.code : undefined)}</p>
              )}
              <button className="btn btn-block" disabled={reportPaid.isPending} onClick={() => reportPaid.mutate()}>
                {t('pay.iPaid')}
              </button>
            </div>
          )}
        </>
      )}

      <Link to={`/orders/${id}`} className="btn btn-secondary btn-block">
        {t('pay.toOrder')}
      </Link>
    </div>
  );
}
