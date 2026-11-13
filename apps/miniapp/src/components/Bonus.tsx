import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n, type MessageKey } from '../lib/i18n';
import { digits, money } from '../lib/format';
import { useBonusAccount, useShopTexts } from '../lib/queries';
import type { BonusView } from '../lib/types';
import { BonusTeaser } from './BonusTeaser';
import { ChevronIcon, CloseIcon, GiftIcon, InfoIcon } from './Icons';

/** "2027-02-12" → "12.02.2027" */
export const dmy = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;

/** 3.10-А: the cashback of a price at the current percent (the server counts the real one after the delivery). */
export const cashbackOf = (price: number, pct: number) => (pct > 0 && price > 0 ? Math.floor((price * pct) / 100) : 0);

/**
 * 3.10-А: «Бонусный кошелёк» in the profile — a navy wallet card: the balance, «Накопительный баланс • Кешбэк 3% с
 * покупок», «Сгорят N сум ДД.ММ». While the bonus programme is off and the balance is empty, the old «Скоро» card stays.
 */
export function BonusCard() {
  const { t, lang } = useI18n();
  const shop = useShopTexts();
  const acc = useBonusAccount();
  const enabled = shop.data?.bonus?.enabled ?? acc.data?.rules.enabled;
  if (!acc.data) return null;
  if (!enabled && acc.data.balance_uzs <= 0) return <BonusTeaser />;
  const a = acc.data;
  return (
    <Link to="/bonus" className="bonus-wallet bonus-wallet-link">
      <span className="bonus-wallet-top">
        <span className="bonus-wallet-icon" aria-hidden>
          <GiftIcon width={20} height={20} />
        </span>
        <span className="bonus-wallet-name">
          <strong>{t('bonus.title')}</strong>
          <span>{t('bonus.cardSub', { pct: a.rules.cashback_pct })}</span>
        </span>
        <ChevronIcon width={18} height={18} className="bonus-wallet-chevron" aria-hidden />
      </span>
      <span className="bonus-wallet-sum">{money(a.balance_uzs, lang)}</span>
      {a.expires_on && <span className="bonus-wallet-burn">{t('bonus.burns', { sum: money(a.balance_uzs, lang), date: dmy(a.expires_on) })}</span>}
    </Link>
  );
}

/** 3.10-А: «Условия бонусной программы VITALO» — five numbered rules and the note; from the wallet and the product card. */
export function BonusTermsSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const shop = useShopTexts();
  const acc = useBonusAccount();
  const r = acc.data?.rules;
  const cashback = r?.cashback_pct ?? shop.data?.bonus?.cashback_pct ?? 3;
  const spend = r?.max_spend_pct ?? shop.data?.bonus?.max_spend_pct ?? 25;
  const days = r?.lifetime_days ?? 90;
  const rules: [MessageKey, MessageKey, Record<string, number>][] = [
    ['bonus.term1Title', 'bonus.term1', { pct: cashback }],
    ['bonus.term2Title', 'bonus.term2', {}],
    ['bonus.term3Title', 'bonus.term3', { pct: spend }],
    ['bonus.term4Title', 'bonus.term4', { days }],
    ['bonus.term5Title', 'bonus.term5', {}],
  ];
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet bonus-sheet" role="dialog" aria-modal="true" aria-label={t('bonus.termsTitle')} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden />
        <div className="sheet-head">
          <h2>{t('bonus.termsTitle')}</h2>
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <ol className="steps bonus-terms">
          {rules.map(([title, text, vars], i) => (
            <li key={title}>
              <span className="step-num" aria-hidden>
                {i + 1}
              </span>
              <span>
                <strong>{t(title)}.</strong> {t(text, vars)}
              </span>
            </li>
          ))}
        </ol>
        <p className="bonus-disclaimer">{t('bonus.disclaimer')}</p>
      </div>
    </div>
  );
}

/** 3.10-А: «Ознакомиться с условиями бонусной системы ›» — a row that opens the rules. */
export function BonusTermsRow() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="bonus-terms-row" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <InfoIcon width={18} height={18} aria-hidden />
        <span>{t('bonus.termsLink')}</span>
        <ChevronIcon width={18} height={18} className="bonus-wallet-chevron" aria-hidden />
      </button>
      {open && <BonusTermsSheet onClose={() => setOpen(false)} />}
    </>
  );
}

/** 3.10-А: «Списать 15 000 бонусных сум» in the cart and at checkout; or why bonuses cannot be spent here. */
export function BonusSwitch({ bonus, busy = false, onToggle }: { bonus?: BonusView; busy?: boolean; onToggle: (use: boolean) => void }) {
  const { t, lang } = useI18n();
  if (!bonus || bonus.blocked === 'disabled' || bonus.blocked === 'empty') return null;
  if (bonus.blocked) return <p className="hint small bonus-blocked">{t(`bonus.blocked.${bonus.blocked}` as MessageKey)}</p>;
  return (
    <label className="list-row switch-row bonus-switch">
      <span>
        <span className="bonus-use">{t('bonus.use', { sum: digits(bonus.available_uzs) })}</span>
        <span className="hint small">{t('bonus.onAccount', { sum: money(bonus.balance_uzs, lang) })}</span>
      </span>
      <input type="checkbox" role="switch" className="switch" checked={bonus.use} disabled={busy} onChange={(e) => onToggle(e.target.checked)} />
    </label>
  );
}

/** 3.10-А: «+1 569 сум на бонусный счёт после доставки» under the total. */
export function CashbackLine({ bonus }: { bonus?: BonusView }) {
  const { t, lang } = useI18n();
  if (!bonus || bonus.cashback_uzs <= 0) return null;
  return <p className="hint small bonus-cashback">{t('bonus.cashback', { sum: money(bonus.cashback_uzs, lang) })}</p>;
}

/** 3.10-А: the cashback pill «+3 750 сум на бонусный баланс» next to the price; a tap opens the rules. */
export function ProductCashback({ price }: { price: number }) {
  const { t, lang } = useI18n();
  const shop = useShopTexts();
  const [open, setOpen] = useState(false);
  const b = shop.data?.bonus;
  const sum = b?.enabled ? cashbackOf(price, b.cashback_pct) : 0;
  if (sum <= 0) return null;
  return (
    <>
      <button type="button" className="cashback-pill" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <span className="cashback-pill-in">
          <GiftIcon width={15} height={15} aria-hidden />
          <span>
            <strong>+{money(sum, lang)}</strong> {t('bonus.productCashback')}
          </span>
        </span>
      </button>
      {open && <BonusTermsSheet onClose={() => setOpen(false)} />}
    </>
  );
}
