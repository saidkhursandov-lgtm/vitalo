import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CopyIcon, ReceiptIcon } from '../components/Icons';
import { ErrorState, Loading, StickyAction } from '../components/ui';
import { api, ApiError, isNetworkError } from '../lib/api';
import { money, orderNo } from '../lib/format';
import { errorText, useI18n, type MessageKey } from '../lib/i18n';
import { useBankTransfer, useShopTexts } from '../lib/queries';
import { copyText, openSupport, paymentCheckWhen } from '../lib/shop';
import { SupportButton } from '../components/Support';
import { PayBy } from '../components/PayBy';
import type { Lang } from '../lib/types';
import { haptic } from '../lib/telegram';

/** "8600123456789012" -> "8600 1234 5678 9012" */
export const prettyCard = (digits: string) => digits.replace(/(\d{4})(?=\d)/g, '$1 ');

function CopyRow({ label, value, copyValue = value }: { label: string; value: string; copyValue?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  // One tap on the value or on the button copies it (D-04)
  const copy = () =>
    void copyText(copyValue).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div className="copy-row">
      <div>
        <div className="hint small">{label}</div>
        <button type="button" className="copy-value copy-tap" onClick={copy}>
          {value}
        </button>
      </div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>
        <CopyIcon width={16} height={16} /> {copied ? t('pay.copied') : t('pay.copy')}
      </button>
    </div>
  );
}

/** Rejection reasons the bot offers are stored in Russian; the Uzbek customer sees them in Uzbek. */
const REASON_UZ: Record<string, string> = {
  'Сумма не совпадает': 'Summa mos kelmaydi',
  'Чек не читается': 'Chek o‘qilmaydi',
  'Платёж не поступил': 'To‘lov kelib tushmagan',
};
export const reasonText = (reason: string | null, lang: Lang) => (reason ? (lang === 'uz' && REASON_UZ[reason]) || reason : '—');

/** When the managers check the transfer (daily hours from the settings), said after «Я оплатил(а)». */
function CheckWhen() {
  const { t } = useI18n();
  const shop = useShopTexts();
  const hours = shop.data?.payment_check_hours ?? { from: '08:00', to: '22:00' };
  const when = paymentCheckWhen(hours);
  return (
    <div className="notice notice-ok">
      <p>{t('pay.waiting')}</p>
      <p className="small">{when === 'now' ? t('pay.next.check', hours) : t(when === 'today' ? 'pay.next.checkToday' : 'pay.next.checkTomorrow', hours)}</p>
    </div>
  );
}

/**
 * Manual transfer on one screen (3.5): the three steps — copy the card number, transfer the sum, send the receipt — and
 * one main button «Я оплатил(а) — отправить чек» that marks the order as paid and opens the shop bot with this order for
 * the receipt (3.1). After that the screen stays the same: «Проверяем оплату», the receipt state and «Отправить чек ещё
 * раз»; there is no second screen any more. Bank requisites (an old order) keep the plain rows and «Я оплатил(а)».
 */
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
  const card = d.method === 'card_transfer' && d.card ? d.card : null;
  const botUrl = card ? d.receipt?.bot_url : null;
  const lastReceipt = d.receipt?.last;
  const rows: [MessageKey, string][] = d.requisites
    ? [
        ['pay.recipient', d.requisites.recipient],
        ['pay.bank', d.requisites.bank_name],
        ['pay.account', d.requisites.account],
        ['pay.mfo', d.requisites.mfo],
        ['pay.inn', d.requisites.inn],
        ['pay.purpose', d.purpose],
      ]
    : [];
  // The tap opens the bot right away (Telegram allows it only inside the tap), then the server notes «оплатил(а)»
  const payAndSend = () => {
    if (botUrl) openSupport(botUrl);
    if (!reported) reportPaid.mutate();
  };

  return (
    <div className="page">
      <h1>{t(d.method === 'card_transfer' ? 'pay.card' : 'pay.bank')}</h1>
      <p className="hint">{t('orders.number', { n: orderNo(d.order_number) })}</p>

      <section className="card amount-card">
        <div className="hint small">{t('pay.amount')}</div>
        <div className="amount">{money(d.amount_uzs, lang)}</div>
      </section>

      {!paid && !cancelled && !reported && d.pay_until && <PayBy until={d.pay_until} />}

      {paid ? (
        <div className="notice notice-ok">{t('pay.paid')}</div>
      ) : cancelled ? (
        <div className="notice notice-error">{t('pay.cancelled')}</div>
      ) : (
        <>
          {reported && <CheckWhen />}
          {lastReceipt?.status === 'rejected' && (
            <div className="notice notice-error" role="alert">
              {t('pay.receiptRejected', { reason: reasonText(lastReceipt.reject_reason, lang) })}
            </div>
          )}
          {reported && lastReceipt?.status === 'pending' && <p className="receipt-sent">{t('pay.receiptSent')}</p>}

          {card ? (
            <section className="card pay-steps">
              <h2>{t('pay.steps.title')}</h2>
              <ol className="steps">
                <li className={reported ? '' : 'is-current'}>
                  <span className="step-num" aria-hidden>1</span>
                  <div className="pay-step-body">
                    <span>{t('pay.step.copy')}</span>
                    <CopyRow label={t('pay.cardNumber')} value={prettyCard(card.card_number)} copyValue={card.card_number} />
                  </div>
                </li>
                <li>
                  <span className="step-num" aria-hidden>2</span>
                  <span>{t('pay.step.transfer', { sum: money(d.amount_uzs, lang) })}</span>
                </li>
                <li className={reported ? 'is-current' : ''}>
                  <span className="step-num" aria-hidden>3</span>
                  <span>{t('pay.step.receipt')}</span>
                </li>
              </ol>
              {botUrl && <p className="hint small">{t('pay.receiptHint')}</p>}
            </section>
          ) : (
            <section className="card">
              {rows.map(([label, value]) => (
                <CopyRow key={label} label={t(label)} value={value} />
              ))}
            </section>
          )}
          {!reported && <p className="notice notice-info">{lang === 'uz' ? d.hint.uz : d.hint.ru}</p>}

          {(!reported || botUrl) && (
            <StickyAction>
              {reportPaid.isError && (
                <p className="error-text" role="alert">
                  {errorText(lang, reportPaid.error instanceof ApiError ? reportPaid.error.code : undefined)}
                  {isNetworkError(reportPaid.error) && ` ${t('pay.retrySafe')}`}
                </p>
              )}
              <button className={`btn btn-block ${reported ? 'btn-secondary' : ''}`} disabled={reportPaid.isPending} onClick={payAndSend}>
                {botUrl && <ReceiptIcon width={20} height={20} aria-hidden />}
                <span>{t(reported ? 'pay.resendReceipt' : botUrl ? 'pay.paidAndSend' : 'pay.iPaid')}</span>
              </button>
            </StickyAction>
          )}
          {reported && <SupportButton className="btn btn-secondary btn-block" />}
        </>
      )}

      <Link to={reported && !paid && !cancelled ? '/orders' : `/orders/${id}`} className="btn btn-secondary btn-block">
        {t(reported && !paid && !cancelled ? 'pay.toOrders' : 'pay.toOrder')}
      </Link>
    </div>
  );
}
