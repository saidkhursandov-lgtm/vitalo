import { Link } from 'react-router-dom';
import { dmy } from '../components/Bonus';
import { ErrorState, Loading } from '../components/ui';
import { money } from '../lib/format';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useBonusAccount } from '../lib/queries';
import type { BonusAccount } from '../lib/types';

type Row = BonusAccount['history'][number];

/** The line of the history: what happened (a reversal is «вернулись» or «кешбэк отменён» by its sign). */
function opKey(r: Row): MessageKey {
  if (r.op === 'reversal') return r.amount_uzs > 0 ? 'bonus.op.refund' : 'bonus.op.unpurchase';
  if (r.op === 'promo' || r.op === 'referral') return 'bonus.op.manual_add';
  return `bonus.op.${r.op}` as MessageKey;
}

const day = (iso: string, lang: string) =>
  new Intl.DateTimeFormat(lang === 'uz' ? 'uz-Latn-UZ' : 'ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));

/** 3.10-А: «VITALO Bonus» — the balance, when it burns, the rules and the history (the bot's «Мои бонусы»). */
export function BonusScreen() {
  const { t, lang } = useI18n();
  const acc = useBonusAccount();
  if (acc.isPending) return <div className="page"><Loading variant="list" count={3} /></div>;
  if (acc.isError) return <ErrorState error={acc.error} onRetry={() => void acc.refetch()} />;
  const a = acc.data;
  const r = a.rules;
  return (
    <div className="page bonus-page">
      <h1>{t('bonus.title')}</h1>
      <section className="card bonus-hero">
        <span className="hint small">{t('bonus.balanceLabel')}</span>
        <strong className="bonus-big">{money(a.balance_uzs, lang)}</strong>
        <span className="small">{t('bonus.payUpTo', { pct: r.max_spend_pct })}</span>
        {a.expires_on && <span className="small bonus-burn">{t('bonus.burns', { sum: money(a.balance_uzs, lang), date: dmy(a.expires_on) })}</span>}
        <Link to="/catalog" className="btn btn-block">{t('common.toCatalog')}</Link>
      </section>

      <section className="card">
        <h2>{t('bonus.rules')}</h2>
        <ul className="bonus-rules">
          <li>{t('bonus.rule1', { pct: r.cashback_pct })}</li>
          <li>{t('bonus.rule2', { pct: r.max_spend_pct })}</li>
          <li>{t('bonus.rule3', { days: r.lifetime_days })}</li>
          <li>{t('bonus.rule4')}</li>
        </ul>
      </section>

      <section className="card list">
        <h2>{t('bonus.history')}</h2>
        {a.history.length === 0 ? (
          <p className="hint small">{t('bonus.historyEmpty')}</p>
        ) : (
          <ul className="bonus-history">
            {a.history.map((h) => (
              <li key={h.id} className="bonus-op">
                <span className="bonus-op-text">
                  <span>{t(opKey(h))}</span>
                  <span className="hint small">
                    {day(h.created_at, lang)}
                    {h.order_number && ` · ${t('bonus.orderNo', { n: h.order_number })}`}
                  </span>
                </span>
                <strong className={h.amount_uzs > 0 ? 'bonus-plus' : 'bonus-minus'}>
                  {h.amount_uzs > 0 ? '+' : '−'}
                  {money(Math.abs(h.amount_uzs), lang)}
                </strong>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
