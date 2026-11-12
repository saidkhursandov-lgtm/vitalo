import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { track } from '../lib/analytics';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useAiCompat, useCompat } from '../lib/queries';
import { AiCompat, SpecialistBox } from './AiCompat';
import { AiGoalBlock } from './AiGoal';
import type { CompatRequest, CompatState, CompatVerdict } from '../lib/types';
import { AlertIcon, CheckIcon, CloseIcon, ShieldIcon } from './Icons';

/** Same products in any order and quantity → the same key (the API compares sets the same way). */
export const setKeyOf = (ids: string[]) => [...new Set(ids)].sort().join(',');

const VERDICT_KEY: Record<CompatVerdict, MessageKey> = { compatible: 'compat.v.compatible', spread: 'compat.v.spread', consult: 'compat.v.consult' };

/** «Не сейчас» on the VITALO AI consent: the cart offers the specialist until the app is opened again. */
const REFUSED_KEY = 'vitalo.ai-refused';
const readRefused = () => {
  try {
    return sessionStorage.getItem(REFUSED_KEY) === '1';
  } catch {
    return false;
  }
};
const writeRefused = (on: boolean) => {
  try {
    if (on) sessionStorage.setItem(REFUSED_KEY, '1');
    else sessionStorage.removeItem(REFUSED_KEY);
  } catch {
    // storage blocked: the choice lives until the screen is left
  }
};

/**
 * Шаг 0а: VITALO AI first; its result only by the tap; with it the specialist answer is a link under the AI answer and
 * «ждём ответа» goes under the block.
 * 3.8 fix: one block. VITALO AI (from one product, AiCompat) — «Спросить специалиста лично» only inside it (the answer,
 * the limit, an error). The AI is off, has no key or the customer closed the consent — the same block leads to the
 * specialist (3.4, 2+ different products). Above it — the specialist's answer for the latest request (with «Состав
 * корзины изменился — проверьте снова» when the cart is another set now) or «ждём ответа» while a specialist has it.
 */
export function CompatBlock({ productIds }: { productIds: string[] }) {
  const { t, lang } = useI18n();
  const setKey = setKeyOf(productIds);
  const compat = useCompat(setKey, lang);
  const ai = useAiCompat(setKey, lang);
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState(readRefused);
  const [askConsent, setAskConsent] = useState(false);
  const s = compat.data;
  // 3.8: VITALO AI works from one product; the specialist (3.4) from two
  const aiOn = !!ai.data?.available && !!ai.data.eligible;
  if (!s || (!s.eligible && !aiOn)) return null;
  const r = s.request;
  const waiting = r?.status === 'pending' && !r.changed;
  // a refusal counts only while there is no consent; with one product the specialist cannot help, the AI block stays
  const showAi = aiOn && !(refused && !ai.data!.consent && s.eligible);
  // Шаг 0а: with VITALO AI the specialist answer is a link under the AI answer; without it — shown above, as in 3.4
  const answered = !showAi && r?.status === 'answered' && r.source !== 'ai' && r.source !== 'ai_cache' ? r : null;
  const canAsk = s.eligible && !waiting && (!answered || answered.changed);
  const pending = s.eligible && waiting && (
    <div className="compat-pending" role="status">
      <ShieldIcon width={20} height={20} aria-hidden />
      <span>
        <strong>{t('compat.pending')}</strong>
        <span>{t('compat.hours')}</span>
      </span>
    </div>
  );
  return (
    <div className="compat">
      {answered && <CompatAnswer request={answered} />}
      {!showAi && pending}
      {showAi ? (
        <AiCompat
          key={`${setKey}|${askConsent ? 'consent' : 'idle'}`}
          state={ai.data!}
          products={s.products}
          canAskSpecialist={canAsk}
          askConsent={askConsent}
          onAsk={() => setOpen(true)}
          below={<AiGoalBlock canAskSpecialist={canAsk} onAsk={() => setOpen(true)} />}
          onRefuse={() => {
            setAskConsent(false);
            writeRefused(true);
            setRefused(true);
          }}
          onChange={(next) => {
            if (next.consent) writeRefused(false);
            client.setQueryData(['compat-ai', setKey, lang], next);
            void client.invalidateQueries({ queryKey: ['compat', setKey, lang] });
          }}
        />
      ) : (
        canAsk && (
          <SpecialistBox
            onAsk={() => setOpen(true)}
            onTryAi={
              aiOn
                ? () => {
                    setAskConsent(true);
                    setRefused(false);
                  }
                : undefined
            }
          />
        )
      )}
      {showAi && pending}
      {open && <CompatSheet state={s} onClose={() => setOpen(false)} onDone={(next) => client.setQueryData(['compat', setKey, lang], next)} />}
    </div>
  );
}

function CompatAnswer({ request }: { request: CompatRequest }) {
  const { t } = useI18n();
  const seen = useRef('');
  useEffect(() => {
    if (seen.current === request.id) return;
    seen.current = request.id;
    track('compat_view', { verdict: request.verdict ?? '', source: request.source, changed: request.changed });
  }, [request.id, request.verdict, request.source, request.changed]);
  const verdict = request.verdict ?? 'consult';
  return (
    <section className={`compat-answer is-${verdict}`} aria-label={t('compat.answerTitle')}>
      <div className="compat-answer-head">
        <span className={`compat-label is-${verdict}`}>{t(VERDICT_KEY[verdict])}</span>
        <span className="compat-answer-title">{request.source === 'instant' ? t('compat.instant') : t('compat.answerTitle')}</span>
      </div>
      {request.text && <p className="compat-answer-text">{request.text}</p>}
      {request.changed && (
        <p className="compat-changed">
          <AlertIcon width={16} height={16} aria-hidden /> {t('compat.changed')}
        </p>
      )}
      <p className="compat-disclaimer">{t('compat.disclaimer')}</p>
    </section>
  );
}

function CompatSheet({ state, onClose, onDone }: { state: CompatState; onClose: () => void; onDone: (s: CompatState) => void }) {
  const { t } = useI18n();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [sent, setSent] = useState<CompatState | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api<CompatState>('/compat', { method: 'POST', body: comment.trim() ? { comment: comment.trim() } : {} });
      onDone(next);
      if (next.result === 'instant') onClose();
      else setSent(next);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      setError(code === 'DAILY_LIMIT' ? 'compat.err.limit' : code === 'ALREADY_PENDING' ? 'compat.err.pending' : 'compat.err.failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet compat-sheet" role="dialog" aria-modal="true" aria-label={t('compat.title')} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden />
        <div className="sheet-head">
          <h2>{t('compat.title')}</h2>
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        {sent ? (
          <>
            <div className="sheet-body compat-sent">
              <span className="compat-sent-icon" aria-hidden>
                <CheckIcon width={28} height={28} />
              </span>
              <h3>{t('compat.sent')}</h3>
              <p>{t('compat.sentHint')}</p>
              <p className="hint small">{t('compat.hours')}</p>
            </div>
            <div className="sheet-actions sheet-actions-one">
              <button type="button" className="btn btn-block" onClick={onClose}>
                <span>{t('compat.ok')}</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="sheet-body">
              <p className="compat-sheet-label">{t('compat.cartList')}</p>
              <ul className="compat-products">
                {state.products.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
              <label className="field">
                <span>{t('compat.comment')}</span>
                <textarea rows={3} maxLength={500} value={comment} placeholder={t('compat.placeholder')} onChange={(e) => setComment(e.target.value)} />
              </label>
              <p className="compat-disclaimer">{t('compat.disclaimer')}</p>
              {error && (
                <p className="error-text small" role="alert">
                  {t(error)}
                </p>
              )}
            </div>
            <div className="sheet-actions sheet-actions-one">
              <button type="button" className="btn btn-block" disabled={busy} onClick={() => void submit()}>
                <span>{t('compat.send')}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
