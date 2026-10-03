import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CopyIcon } from '../components/Icons';
import { ErrorState, Loading } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime, money } from '../lib/format';
import { errorText, useI18n, type MessageKey } from '../lib/i18n';
import { useBankTransfer, useShopTexts } from '../lib/queries';
import { copyText, daysText, paymentCheckWhen } from '../lib/shop';
import { SupportButton } from '../components/Support';
import type { DeliveryEta } from '../lib/types';
import { haptic } from '../lib/telegram';

/** "8600123456789012" -> "8600 1234 5678 9012" */
export const prettyCard = (digits: string) => digits.replace(/(\d{4})(?=\d)/g, '$1 ');

function CopyRow({ label, value, copyValue = value }: { label: string; value: string; copyValue?: string }) {
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
        className="btn btn-secondary btn-sm"
        onClick={() =>
          void copyText(copyValue).then((ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        <CopyIcon width={16} height={16} /> {copied ? t('pay.copied') : t('pay.copy')}
      </button>
    </div>
  );
}

/**
 * After "Я оплатил(а)": what happens next — payment check (with the daily hours from the settings),
 * picking, courier, delivery term — and the support / copy number / my orders buttons (A5).
 */
function NextSteps({ orderNumber, eta }: { orderNumber: string; eta?: DeliveryEta | null }) {
  const { t, lang } = useI18n();
  const shop = useShopTexts();
  const [copied, setCopied] = useState(false);
  const hours = shop.data?.payment_check_hours ?? { from: '08:00', to: '22:00' };
  const when = paymentCheckWhen(hours);
  const term = daysText(eta?.min_days, eta?.max_days, shop.data?.delivery_days_label, lang);
  const steps = [
    when === 'now' ? t('pay.next.check', hours) : t(when === 'today' ? 'pay.next.checkToday' : 'pay.next.checkTomorrow', hours),
    t('pay.next.pick'),
    t('pay.next.courier'),
    term ? t('pay.next.delivery', { days: term }) : t('pay.next.deliveryNoTerm'),
  ];
  return (
    <>
      <div className="notice notice-ok">{t('pay.waiting')}</div>
      <section className="card">
        <h2>{t('pay.next.title')}</h2>
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={i} className={i === 0 ? 'is-current' : ''}>
              <span className="step-num" aria-hidden>
                {i + 1}
              </span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      </section>
      <SupportButton className="btn btn-block" />
      <button
        type="button"
        className="btn btn-secondary btn-block"
        onClick={() =>
          void copyText(orderNumber).then((ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        <CopyIcon width={18} height={18} /> {copied ? t('pay.copied') : t('pay.copyNumber')}
      </button>
      <Link to="/orders" className="btn btn-secondary btn-block">
        {t('pay.toOrders')}
      </Link>
    </>
  );
}

/** Manual transfer instruction (card or bank requisites, from admin settings) + "Я оплатил(а)". */
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

  if (details.isPending) return <div className="page"><Loading /></div>;
  if (details.isError) return <ErrorState error={details.error} onRetry={() => void details.refetch()} />;
  const d = details.data;

  const paid = d.payment_status === 'payment_success';
  const cancelled = d.status === 'cancelled';
  const reported = !!d.customer_reported_paid_at || reportPaid.isSuccess;
  const rows: [MessageKey, string, string?][] =
    d.method === 'card_transfer' && d.card
      ? [
          ['pay.cardNumber', prettyCard(d.card.card_number), d.card.card_number],
          ['pay.cardRecipient', d.card.recipient],
        ]
      : d.requisites
        ? [
            ['pay.recipient', d.requisites.recipient],
            ['pay.bank', d.requisites.bank_name],
            ['pay.account', d.requisites.account],
            ['pay.mfo', d.requisites.mfo],
            ['pay.inn', d.requisites.inn],
            ['pay.purpose', d.purpose],
          ]
        : [];

  return (
    <div className="page">
      <h1>{t(d.method === 'card_transfer' ? 'pay.card' : 'pay.bank')}</h1>
      <p className="hint">{t('orders.number', { n: d.order_number })}</p>

      <section className="card amount-card">
        <div className="hint small">{t('pay.amount')}</div>
        <div className="amount">{money(d.amount_uzs, lang)}</div>
        {!paid && !cancelled && !reported && d.pay_until && <p className="small">{t('pay.until', { date: dateTime(d.pay_until, lang) })}</p>}
      </section>

      {paid ? (
        <div className="notice notice-ok">{t('pay.paid')}</div>
      ) : cancelled ? (
        <div className="notice notice-error">{t('pay.cancelled')}</div>
      ) : reported ? (
        <NextSteps orderNumber={d.order_number} eta={d.delivery_eta} />
      ) : (
        <>
          <section className="card">
            {rows.map(([label, value, copy]) => (
              <CopyRow key={label} label={t(label)} value={value} copyValue={copy} />
            ))}
          </section>
          <p className="notice notice-info">{lang === 'uz' ? d.hint.uz : d.hint.ru}</p>

          {(
            <div className="sticky-action">
              {reportPaid.isError && <p className="error-text">{errorText(lang, reportPaid.error instanceof ApiError ? reportPaid.error.code : undefined)}</p>}
              <button className="btn btn-block" disabled={reportPaid.isPending} onClick={() => reportPaid.mutate()}>
                {t('pay.iPaid')}
              </button>
            </div>
          )}
        </>
      )}

      {!(reported && !paid && !cancelled) && (
        <Link to={`/orders/${id}`} className="btn btn-secondary btn-block">
          {t('pay.toOrder')}
        </Link>
      )}
    </div>
  );
}
