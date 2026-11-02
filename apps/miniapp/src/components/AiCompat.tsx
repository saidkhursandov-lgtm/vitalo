import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { track } from '../lib/analytics';
import { useI18n, type MessageKey } from '../lib/i18n';
import type { AiAnswer, AiState, CompatVerdict } from '../lib/types';
import { AlertIcon, ChevronIcon, CloseIcon, InfoIcon, SearchIcon, SparkIcon } from './Icons';

const VERDICT_KEY: Record<CompatVerdict, MessageKey> = { compatible: 'compat.v.compatible', spread: 'compat.v.spread', consult: 'compat.v.consult' };

/** The search animation is shown at least this long (spec 2.3: 2–3 s), even when the answer comes from the cache. Tests set 0. */
export const AI_MIN_MS = { value: 2200 };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Note = 'limit' | 'fallback' | 'unavailable' | 'failed';

/**
 * 3.8: VITALO AI in the cart (D-45, D-47; docs/releases/vitalo-ai.md, 2.1–2.5). One product — «С чем сочетать этот
 * препарат?», 2+ — «Проверить совместимость (VITALO AI)». The first time — the consent; then 2–3 s of the search
 * animation and the answer card: the label, the text, when to take each product, repeats of a substance, medicine lines.
 */
export function AiCompat({
  state,
  products,
  canAskSpecialist,
  onAsk,
  onChange,
}: {
  state: AiState;
  products: string[];
  canAskSpecialist: boolean;
  onAsk: () => void;
  onChange: (next: AiState) => void;
}) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<'idle' | 'consent' | 'checking'>('idle');
  const [note, setNote] = useState<Note | null>(null);

  const run = async () => {
    setPhase('checking');
    setNote(null);
    const started = Date.now();
    let next: AiState | null = null;
    let failed: Note | 'consent' | null = null;
    try {
      next = await api<AiState>('/compat/ai/check', { method: 'POST' });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      failed = code === 'AI_DAILY_LIMIT' ? 'limit' : code === 'CONSENT_REQUIRED' ? 'consent' : code === 'BUSY' ? null : 'failed';
    }
    await wait(Math.max(0, AI_MIN_MS.value - (Date.now() - started)));
    if (failed === 'consent') return setPhase('consent');
    setPhase('idle');
    if (failed) setNote(failed);
    if (next) {
      onChange(next);
      if (next.result === 'specialist') setNote('fallback');
      if (next.result === 'unavailable') setNote('unavailable');
    }
  };

  const one = products.length === 1;
  return (
    <div className="ai-compat">
      {phase === 'checking' ? (
        <AiScan products={products} />
      ) : state.answer ? (
        <AiAnswerCard answer={state.answer} canAskSpecialist={canAskSpecialist} onAsk={onAsk} />
      ) : (
        <>
          <p className="ai-hint">{t('ai.hint')}</p>
          <button type="button" className="ask-card ai-button" onClick={() => (state.consent ? void run() : setPhase('consent'))}>
            <span className="ask-icon" aria-hidden>
              <SparkIcon width={20} height={20} />
            </span>
            <span className="ask-text">
              <strong>{t(one ? 'ai.checkOne' : 'ai.check')}</strong>
            </span>
            <ChevronIcon className="ask-chevron" width={20} height={20} aria-hidden />
          </button>
        </>
      )}
      {note && (
        <div className={`ai-note${note === 'fallback' ? ' is-info' : ''}`} role="status">
          {note === 'fallback' ? <InfoIcon width={18} height={18} aria-hidden /> : <AlertIcon width={18} height={18} aria-hidden />}
          <span>
            {t(`ai.${note}` as MessageKey)}
            {note === 'limit' && canAskSpecialist && (
              <button type="button" className="link ai-note-action" onClick={onAsk}>
                {t('ai.writeSpecialist')}
              </button>
            )}
          </span>
        </div>
      )}
      {phase === 'consent' && (
        <AiConsentSheet
          onClose={() => setPhase('idle')}
          onAgreed={(next) => {
            onChange(next);
            void run();
          }}
        />
      )}
    </div>
  );
}

/** A lens moving over the cart and two statuses in turn; without motion when the system asks for less of it. */
function AiScan({ products }: { products: string[] }) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % 2), 1100);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="ai-scan" role="status" aria-live="polite">
      <div className="ai-scan-box" aria-hidden>
        <ul>
          {products.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
        <span className="ai-lens">
          <SearchIcon width={26} height={26} />
        </span>
      </div>
      <p>{t(step ? 'ai.status2' : 'ai.status1')}</p>
    </div>
  );
}

function AiAnswerCard({ answer, canAskSpecialist, onAsk }: { answer: AiAnswer; canAskSpecialist: boolean; onAsk: () => void }) {
  const { t } = useI18n();
  const seen = useRef('');
  useEffect(() => {
    if (seen.current === answer.answer_id) return;
    seen.current = answer.answer_id;
    track('compat_view', { verdict: answer.verdict, source: 'ai', changed: false });
  }, [answer.answer_id, answer.verdict]);
  return (
    <section className={`compat-answer ai-answer is-${answer.verdict}`} aria-label="VITALO AI">
      <div className="compat-answer-head">
        <span className={`compat-label is-${answer.verdict}`}>{t(VERDICT_KEY[answer.verdict])}</span>
        <span className="compat-answer-title">{t('ai.source')}</span>
      </div>
      <p className="compat-answer-text">{answer.text}</p>
      {answer.overlap_text && (
        <p className="compat-changed ai-overlap">
          <AlertIcon width={16} height={16} aria-hidden /> {answer.overlap_text} ({answer.overlaps.join(', ')})
        </p>
      )}
      {answer.timing.length > 0 && (
        <>
          <h3 className="ai-sub">{t('ai.timing')}</h3>
          <ul className="ai-timing">
            {answer.timing.map((x) => (
              <li key={x.product_id}>
                <span>{x.name}</span>
                <strong>{x.when}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
      {answer.suggestions.length > 0 && (
        <>
          <h3 className="ai-sub">{t('ai.suggest')}</h3>
          <ul className="ai-suggest">
            {answer.suggestions.map((p) => (
              <li key={p.product_id}>
                <Link to={`/product/${p.product_id}`}>
                  <span>{p.name}</span>
                  <ChevronIcon width={18} height={18} aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {answer.drugs.map((d) => (
        <p key={d} className="ai-drug">
          {d}
        </p>
      ))}
      <div className="ai-meds">
        <span>{t('ai.drugs')}</span>
        {canAskSpecialist && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onAsk}>
            <span>{t('ai.askSpecialist')}</span>
          </button>
        )}
      </div>
      <p className="compat-disclaimer">{t('compat.disclaimer')}</p>
    </section>
  );
}

/** The consent, once for all of VITALO AI (D-47). «Правила использования» are not published yet — plain text until then. */
function AiConsentSheet({ onClose, onAgreed }: { onClose: () => void; onAgreed: (next: AiState) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [before, after] = t('ai.consentAccept').split('{privacy}');
  const [lead, tail] = before.split('{rules}');
  const agree = async () => {
    setBusy(true);
    setError(false);
    try {
      onAgreed(await api<AiState>('/compat/ai/consent', { method: 'POST' }));
    } catch {
      setError(true);
      setBusy(false);
    }
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet compat-sheet" role="dialog" aria-modal="true" aria-label={t('ai.consentTitle')} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden />
        <div className="sheet-head">
          <h2>{t('ai.consentTitle')}</h2>
          <button type="button" className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="sheet-body ai-consent">
          <p>{t('ai.consentBody')}</p>
          <p>
            {lead}
            <strong>{t('ai.consentRules')}</strong>
            {tail}
            <Link to="/legal/privacy" className="link">
              {t('ai.consentPrivacy')}
            </Link>
            {after}
          </p>
          {error && (
            <p className="error-text small" role="alert">
              {t('ai.failed')}
            </p>
          )}
        </div>
        <div className="sheet-actions sheet-actions-one">
          <button type="button" className="btn btn-block" disabled={busy} onClick={() => void agree()}>
            <span>{t('ai.agree')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
