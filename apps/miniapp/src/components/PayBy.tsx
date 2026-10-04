import { dateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';

/** Big "Оплатите до 04.10.2026, 14:15" (Tashkent time) while an order waits for payment. */
export function PayBy({ until }: { until: string }) {
  const { t, lang } = useI18n();
  return (
    <div className="pay-by" role="status">
      <strong>{t('pay.payBy', { date: dateTime(until, lang) })}</strong>
      <span>{t('pay.payByHint')}</span>
    </div>
  );
}
