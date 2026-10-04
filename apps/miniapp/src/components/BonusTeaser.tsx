import { useState } from 'react';
import { useI18n } from '../lib/i18n';
import { useShopTexts } from '../lib/queries';
import { CloseIcon, GiftIcon } from './Icons';

/**
 * «VITALO Bonus — скоро» (B4). Interface only: no balance, no numbers, no requests to bonus tables.
 * Tapping opens how it will work. Switched on/off and worded in the admin panel (Настройки → Тексты).
 */
export function BonusTeaser() {
  const { t, lang } = useI18n();
  const shop = useShopTexts();
  const [open, setOpen] = useState(false);
  const teaser = shop.data?.bonus_teaser;
  if (!teaser?.enabled) return null;
  return (
    <>
      <button type="button" className="bonus-card" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <span className="bonus-icon">
          <GiftIcon width={24} height={24} />
        </span>
        <span className="bonus-body">
          <span className="bonus-head">
            <strong>{t('bonus.title')}</strong>
            <span className="soon-badge">{t('bonus.soon')}</span>
          </span>
          <span className="small">{t('bonus.balance')}</span>
          <span className="hint small">{lang === 'uz' ? teaser.text.uz : teaser.text.ru}</span>
        </span>
      </button>
      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="sheet bonus-sheet" role="dialog" aria-label={t('bonus.title')} onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" aria-hidden />
            <div className="sheet-head">
              <h2>{t('bonus.howTitle')}</h2>
              <button className="icon-btn" aria-label={t('common.close')} onClick={() => setOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            <ol className="steps">
              {(['bonus.step1', 'bonus.step2', 'bonus.step3'] as const).map((k, i) => (
                <li key={k}>
                  <span className="step-num" aria-hidden>
                    {i + 1}
                  </span>
                  <span>{t(k)}</span>
                </li>
              ))}
            </ol>
            <p className="notice notice-info">{t('bonus.launch')}</p>
          </div>
        </div>
      )}
    </>
  );
}
