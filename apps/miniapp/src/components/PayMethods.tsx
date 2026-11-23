import { useState } from 'react';
import { track } from '../lib/analytics';
import { useI18n } from '../lib/i18n';
import type { OnlineProvider, PaymentMethodCode } from '../lib/types';
import { CardPayIcon, CashIcon } from './Icons';

export const PAY_LOGOS: Record<OnlineProvider, { name: string; src: string }> = {
  payme: { name: 'Payme', src: '/payment/payme.png' },
  click: { name: 'Click', src: '/payment/click.png' },
  uzum: { name: 'Uzum', src: '/payment/uzum.png' },
};

/** One method of the list: one you can choose, one shown disabled with the reason, or one «Скоро». */
export interface PayCard {
  code: PaymentMethodCode | OnlineProvider;
  state: 'ok' | 'disabled' | 'soon';
  desc: string;
}

const isOnline = (c: string): c is OnlineProvider => c in PAY_LOGOS;

/**
 * 6а-Г (D-62), redone 23.11.2026 after the owner's review — two groups:
 * «Онлайн» — Payme, Click, Uzum as logo tiles in one row, no text under them (one line about the chosen method is
 * under the list). «Другие способы» — «Перевод на карту» and «При получении» as short rows. A system «Скоро» is a
 * grey tile with a small «Скоро» (a tap explains it in a sheet); a disabled method shows its reason, nothing else does.
 */
export function PayMethods({ cards, value, onChange }: { cards: PayCard[]; value: string; onChange: (code: PaymentMethodCode) => void }) {
  const { t } = useI18n();
  const [soon, setSoon] = useState<OnlineProvider | null>(null);
  const online = cards.filter((c) => isOnline(c.code));
  const other = cards.filter((c) => !isOnline(c.code));
  const disabledOnline = online.find((c) => c.state === 'disabled');

  const tile = (c: PayCard) => {
    const code = c.code as OnlineProvider;
    const img = <img src={PAY_LOGOS[code].src} alt="" />;
    if (c.state === 'soon') {
      return (
        <button
          key={code}
          type="button"
          className="pay-tile is-soon"
          aria-label={`${PAY_LOGOS[code].name} · ${t('pay.soon')}`}
          onClick={() => {
            setSoon(code);
            track('payment_soon_click', { system: code });
          }}
        >
          {img}
          <span className="pay-tile-soon">{t('pay.soon')}</span>
        </button>
      );
    }
    const on = value === code;
    return (
      <label key={code} className={`pay-tile ${on ? 'is-on' : ''} ${c.state === 'disabled' ? 'is-disabled' : ''}`}>
        <input
          type="radio"
          name="payment"
          className="visually-hidden"
          aria-label={PAY_LOGOS[code].name}
          checked={on}
          disabled={c.state === 'disabled'}
          onChange={() => onChange(code as PaymentMethodCode)}
        />
        {img}
        {on && <span className="pay-tile-check" aria-hidden />}
      </label>
    );
  };

  const row = (c: PayCard) => {
    const on = value === c.code;
    const Icon = c.code === 'cod' ? CashIcon : CardPayIcon;
    return (
      <label key={c.code} className={`pay-row ${on ? 'is-on' : ''} ${c.state === 'disabled' ? 'is-disabled' : ''}`}>
        <span className="pay-row-icon">
          <Icon width={20} height={20} />
        </span>
        <span className="pay-row-text">
          <strong>{c.code === 'cod' ? t('pay.cod') : t('pay.card')}</strong>
          {c.state === 'disabled' && <span className="hint small">{c.desc}</span>}
        </span>
        <input type="radio" name="payment" checked={on} disabled={c.state === 'disabled'} onChange={() => onChange(c.code as PaymentMethodCode)} />
      </label>
    );
  };

  return (
    <div className="pay-methods">
      {online.length > 0 && (
        <>
          <p className="pay-group-title">{t('pay.groupOnline')}</p>
          <div className="pay-tiles" style={{ gridTemplateColumns: `repeat(${Math.min(online.length, 3)}, minmax(0, 1fr))` }}>
            {online.map(tile)}
          </div>
          {disabledOnline && <p className="hint small pay-tile-note">{disabledOnline.desc}</p>}
        </>
      )}
      {other.length > 0 && (
        <>
          {online.length > 0 && <p className="pay-group-title">{t('pay.groupOther')}</p>}
          <div className="pay-rows">{other.map(row)}</div>
        </>
      )}
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
