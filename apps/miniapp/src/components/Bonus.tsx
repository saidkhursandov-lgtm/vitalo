import { Link } from 'react-router-dom';
import { useI18n, type MessageKey } from '../lib/i18n';
import { digits, money } from '../lib/format';
import { useBonusAccount, useShopTexts } from '../lib/queries';
import type { BonusView } from '../lib/types';
import { BonusTeaser } from './BonusTeaser';
import { ChevronIcon, GiftIcon } from './Icons';

/** "2027-02-12" → "12.02.2027" */
export const dmy = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;

/** 3.10-А: the cashback of a price at the current percent (the server counts the real one after the delivery). */
export const cashbackOf = (price: number, pct: number) => (pct > 0 && price > 0 ? Math.floor((price * pct) / 100) : 0);

/**
 * 3.10-А: «VITALO Bonus» in the profile — the balance, «Оплачивайте бонусами до 25% заказа», «Сгорят N сум ДД.ММ».
 * While the bonus programme is off and the balance is empty, the old «Скоро» card stays (its own switch).
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
    <Link to="/bonus" className="bonus-card bonus-live">
      <span className="bonus-icon">
        <GiftIcon width={24} height={24} />
      </span>
      <span className="bonus-body">
        <strong>{t('bonus.title')}</strong>
        <span className="bonus-balance">{money(a.balance_uzs, lang)}</span>
        <span className="hint small">{t('bonus.payUpTo', { pct: a.rules.max_spend_pct })}</span>
        {a.expires_on && <span className="small bonus-burn">{t('bonus.burns', { sum: money(a.balance_uzs, lang), date: dmy(a.expires_on) })}</span>}
      </span>
      <ChevronIcon width={18} height={18} className="bonus-chevron" aria-hidden />
    </Link>
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

/** 3.10-А: «+ 1 500 сум на бонусный счёт» on the product card. */
export function ProductCashback({ price }: { price: number }) {
  const { t, lang } = useI18n();
  const shop = useShopTexts();
  const b = shop.data?.bonus;
  const sum = b?.enabled ? cashbackOf(price, b.cashback_pct) : 0;
  if (sum <= 0) return null;
  return (
    <p className="product-cashback small">
      <GiftIcon width={16} height={16} aria-hidden />
      <span>{t('bonus.productCashback', { sum: money(sum, lang) })}</span>
    </p>
  );
}
