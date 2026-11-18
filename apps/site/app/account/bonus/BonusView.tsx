'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { money } from '@/lib/format';
import type { BonusAccount, Lang } from '@/lib/types';
import { useSession } from '@/components/Session';
import { AccountShell } from '@/components/AccountShell';
import type { Key } from '@/lib/i18n';

type Row = BonusAccount['history'][number];

/** The history line: a reversal is «вернулись» or «кешбэк отменён» by its sign (same as the Mini App). */
export function opKey(r: Pick<Row, 'op' | 'amount_uzs'>): Key {
  if (r.op === 'reversal') return r.amount_uzs > 0 ? 'bonus.op.refund' : 'bonus.op.unpurchase';
  if (r.op === 'promo' || r.op === 'referral') return 'bonus.op.manual_add';
  return `bonus.op.${r.op}` as Key;
}

const day = (iso: string, lang: Lang) =>
  new Intl.DateTimeFormat(lang === 'uz' ? 'uz-Latn-UZ' : 'ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
/** 2026-12-31 -> 31.12.2026 (the burn day is a plain date, no time zone). */
const dmy = (d: string) => d.split('-').reverse().join('.');

export function BonusView() {
  const { t } = useSession();
  return (
    <AccountShell section="bonus" title={t('bonus.title')}>
      <Bonus />
    </AccountShell>
  );
}

function Bonus() {
  const { t, lang } = useSession();
  const [acc, setAcc] = useState<BonusAccount | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void api<BonusAccount>('/bonus').then(setAcc, () => setFailed(true));
  }, []);

  if (failed) return <div className="notice notice-error">{t('common.error')}</div>;
  if (!acc) {
    return (
      <div className="wait">
        <span className="spinner" aria-label={t('common.loading')} />
      </div>
    );
  }
  const r = acc.rules;
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="bonus-hero">
        <span>{t('bonus.balance')}</span>
        <b>{money(acc.balance_uzs, lang)}</b>
        {r.enabled ? <span className="bonus-chip">{t('bonus.badge', { pct: r.cashback_pct })}</span> : null}
        {acc.expires_on && acc.balance_uzs > 0 ? <span className="bonus-burn">{t('bonus.burns', { sum: money(acc.balance_uzs, lang), date: dmy(acc.expires_on) })}</span> : null}
        <Link href="/catalog" className="btn btn-light">
          {t('home.heroCatalog')}
        </Link>
      </section>

      {r.enabled ? (
        <section className="card ck-section">
          <h2>{t('acc.bonusRules')}</h2>
          <ul className="rules-list">
            <li>{t('acc.ruleCashback', { pct: r.cashback_pct })}</li>
            <li>{t('acc.ruleSpend', { pct: r.max_spend_pct })}</li>
            <li>{t('acc.ruleLife', { days: r.lifetime_days })}</li>
            {r.review_uzs > 0 ? <li>{t('acc.ruleReview', { plain: money(r.review_uzs, lang), photo: money(r.review_photo_uzs, lang) })}</li> : null}
          </ul>
        </section>
      ) : null}

      <section className="card ck-section">
        <h2>{t('bonus.history')}</h2>
        {acc.history.length === 0 ? (
          <p className="hint">{t('bonus.historyEmpty')}</p>
        ) : (
          <ul className="bonus-history">
            {acc.history.map((h) => (
              <li key={h.id}>
                <span>
                  <span>{t(opKey(h))}</span>
                  <span className="hint">
                    {day(h.created_at, lang)}
                    {h.order_number ? ` · ${t('bonus.orderNo', { n: h.order_number })}` : ''}
                  </span>
                </span>
                <b className={h.amount_uzs > 0 ? 'plus' : 'minus'}>
                  {h.amount_uzs > 0 ? '+' : '−'}
                  {money(Math.abs(h.amount_uzs), lang)}
                </b>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
