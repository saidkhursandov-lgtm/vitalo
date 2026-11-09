import { useState, type ReactNode } from 'react';
import { track } from '../lib/analytics';
import { useI18n } from '../lib/i18n';
import type { OnlineProvider, PaymentMethodCode } from '../lib/types';
import { CardPayIcon, CashIcon } from './Icons';

export const PAY_LOGOS: Record<OnlineProvider, { name: string; src: string }> = {
  payme: { name: 'Payme', src: '/payment/payme.png' },
  click: { name: 'Click', src: '/payment/click.png' },
  uzum: { name: 'Uzum', src: '/payment/uzum.png' },
};

/** One card of the list: a method you can choose, one shown disabled with the reason, or one «Скоро». */
export interface PayCard {
  code: PaymentMethodCode | OnlineProvider;
  state: 'ok' | 'disabled' | 'soon';
  desc: string;
}

const isOnline = (c: string): c is OnlineProvider => c in PAY_LOGOS;

/**
 * 6а-Г (D-62): every payment method is the same card — a logo box on the left, the name and one line under it, the
 * choice on the right. Payme, Click, Uzum, «Перевод на карту», «При получении» look alike; a system «Скоро» is the
 * same card, greyed, with the «Скоро» chip — a tap explains it in a sheet.
 */
export function PayMethods({ cards, value, onChange }: { cards: PayCard[]; value: string; onChange: (code: PaymentMethodCode) => void }) {
  const { t } = useI18n();
  const [soon, setSoon] = useState<OnlineProvider | null>(null);
  const title = (c: PayCard['code']) => (isOnline(c) ? PAY_LOGOS[c].name : c === 'cod' ? t('pay.cod') : t('pay.card'));
  const logo = (c: PayCard['code']): ReactNode =>
    isOnline(c) ? (
      <span className="pay-card-logo">
        <img src={PAY_LOGOS[c].src} alt="" />
      </span>
    ) : (
      <span className="pay-card-logo is-icon">{c === 'cod' ? <CashIcon width={22} height={22} /> : <CardPayIcon width={22} height={22} />}</span>
    );

  return (
    <div className="pay-methods">
      {cards.map((c) => {
        const text = (
          <span className="pay-card-text">
            <strong>{title(c.code)}</strong>
            <span className="hint small">{c.desc}</span>
          </span>
        );
        if (c.state === 'soon' && isOnline(c.code)) {
          const code = c.code;
          return (
            <button
              key={code}
              type="button"
              className="pay-card is-soon"
              aria-label={`${PAY_LOGOS[code].name} · ${t('pay.soon')}`}
              onClick={() => {
                setSoon(code);
                track('payment_soon_click', { system: code });
              }}
            >
              {logo(code)}
              {text}
              <span className="soon-badge">{t('pay.soon')}</span>
            </button>
          );
        }
        const on = value === c.code;
        return (
          <label key={c.code} className={`pay-card ${on ? 'is-on' : ''} ${c.state === 'disabled' ? 'is-disabled' : ''}`}>
            {logo(c.code)}
            {text}
            <input type="radio" name="payment" checked={on} disabled={c.state === 'disabled'} onChange={() => onChange(c.code as PaymentMethodCode)} />
          </label>
        );
      })}
      {soon && (
        <div className="sheet-backdrop" onClick={() => setSoon(null)}>
          <div className="sheet confirm-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" aria-hidden />
            <img className="online-soon-logo" src={PAY_LOGOS[soon].src} alt={PAY_LOGOS[soon].name} height={32} />
            <p className="confirm-text">{t('pay.soonSheet', { system: PAY_LOGOS[soon].name })}</p>
            <div className="sheet-actions sheet-actions-one">
              <button type="button" className="btn btn-block" onClick={() => setSoon(null)} autoFocus>
                {t('pay.soonOk')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
