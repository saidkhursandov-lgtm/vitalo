import { useState } from 'react';
import { track } from '../lib/analytics';
import { useI18n } from '../lib/i18n';
import type { PromoView } from '../lib/types';
import { ChevronIcon, CloseIcon } from './Icons';

export type PromoApplyResult = { ok: true; promo: PromoView } | { ok: false; reason: string; message: string };

/**
 * 3.3: «У меня есть промокод ›» above the total (cart and checkout). Collapsed → a field with «Применить» → a green line
 * «Промокод VITALO10 применён (−20 000 сум)» with [✕]. The server checks the code and computes the discount; this block
 * only shows the answer. Events: promo_apply_success, promo_apply_fail (with the reason), promo_remove.
 */
/** «−36 900 сум» never breaks across lines: non-breaking spaces inside the sum and before the currency. */
export const keepSums = (text: string) => text.replace(/(\d) (?=\d{3}\b)/g, '$1 ').replace(/ (сум|so‘m)/g, ' $1');

export function PromoBox({ applied, place, onApply, onRemove }: {
  applied: PromoView | null | undefined;
  place: 'cart' | 'checkout';
  onApply: (code: string) => Promise<PromoApplyResult>;
  onRemove: () => Promise<unknown>;
}) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: { preventDefault(): void; stopPropagation(): void }) {
    e.preventDefault();
    e.stopPropagation();
    const text = code.trim();
    if (!text) return setError(t('promo.empty'));
    setBusy(true);
    setError(null);
    try {
      const r = await onApply(text);
      if (r.ok) {
        track('promo_apply_success', { code: r.promo.code, discount_uzs: r.promo.discount_uzs, place });
        setCode('');
        setOpen(false);
      } else {
        track('promo_apply_fail', { code: text.toUpperCase(), reason: r.reason, place });
        setError(r.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!applied) return;
    setBusy(true);
    try {
      await onRemove();
      track('promo_remove', { code: applied.code, place });
    } finally {
      setBusy(false);
    }
  }

  if (applied) {
    const description = lang === 'uz' ? applied.description_uz : applied.description_ru;
    return (
      <div className="promo-applied" role="status">
        <div className="promo-applied-text">
          <strong>{keepSums(lang === 'uz' ? applied.message_uz : applied.message_ru)}</strong>
          {description && <span className="small block">{description}</span>}
          {applied.capped && <span className="small block">{t('promo.capped')}</span>}
        </div>
        <button type="button" className="icon-btn promo-remove" aria-label={t('promo.remove')} disabled={busy} onClick={() => void remove()}>
          <CloseIcon width={20} height={20} />
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="promo-toggle" onClick={() => setOpen(true)} aria-expanded={false}>
        <span>{t('promo.toggle')}</span>
        <ChevronIcon width={18} height={18} aria-hidden />
      </button>
    );
  }

  // a <div>, not a <form>: the checkout screen is a form already (nested forms are not allowed)
  return (
    <div className="promo-form">
      <label className="promo-field">
        <span className="visually-hidden">{t('promo.label')}</span>
        <input
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit(e);
          }}
          placeholder={t('promo.placeholder')}
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={32}
          aria-invalid={!!error}
          aria-describedby={error ? 'promo-error' : undefined}
          autoFocus
        />
        <button type="button" className="btn promo-apply" disabled={busy} onClick={(e) => void submit(e)}>
          {t('promo.apply')}
        </button>
      </label>
      {error && (
        <small id="promo-error" className="error-text block" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
