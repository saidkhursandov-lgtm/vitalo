import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { track } from '../lib/analytics';
import { pluralForm, useI18n, type MessageKey } from '../lib/i18n';
import type { AiAnswer, AiState, CompatVerdict } from '../lib/types';
import { AlertIcon, CheckIcon, ChevronIcon, CloseIcon, InfoIcon, MoonIcon, ShieldIcon, SparkIcon, SunIcon } from './Icons';

/** The analysis animation is shown at least this long (spec 2.3: 2–3 s). Tests set 0. */
export const AI_MIN_MS = { value: 2200 };
/** …and this long when the answer is ready without a new check (a saved or cached answer). */
export const AI_CACHED_MS = { value: 1000 };

const STEPS: MessageKey[] = ['ai.step1', 'ai.step2', 'ai.step3', 'ai.step4'];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

type Note = 'limit' | 'fallback' | 'unavailable' | 'failed';

/** D-70: a product of the cart for the thumbnails of the block. */
export interface AiCartItem {
  product_id: string;
  name: string;
  image_url: string | null;
}

/** D-70: the set checked last in this app session — the same set shows its answer again, another one says «изменилась». */
const CHECKED_KEY = 'vitalo.ai-checked';
/** D-70: «Скрыть» is remembered on the phone. */
const FOLDED_KEY = 'vitalo.ai-folded';
const readStore = (store: () => Storage, key: string) => {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
};
const writeStore = (store: () => Storage, key: string, value: string | null) => {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {
    // storage blocked: the choice lives until the screen is left
  }
};
const session = () => sessionStorage;
const local = () => localStorage;

/** «Сверяю 1 товар / 2 товара / 5 товаров». */
export function goodsAcc(n: number, lang: 'ru' | 'uz'): string {
  if (lang === 'uz') return 'mahsulot';
  return { one: 'товар', few: 'товара', many: 'товаров' }[pluralForm(n)];
}

/** «3 товаров», «21 товара» (after «совместимость»); Uzbek has no plural after a number. */
export function goodsWord(n: number, lang: 'ru' | 'uz'): string {
  if (lang === 'uz') return 'mahsulot';
  return pluralForm(n) === 'one' ? 'товара' : 'товаров';
}
type Tone = 'green' | 'yellow' | 'red';

/**
 * 3.8 fix: the badge of the answer by its reason. Green «Хорошо сочетаются» only when a «синергия» rule fired, else
 * «Конфликтов не найдено»; yellow «Разнести по времени», or «Проверьте дозировку» when a repeated substance is the only
 * reason; red «Нужна консультация».
 */
export function aiBadge(a: Pick<AiAnswer, 'verdict' | 'reasons'>): { tone: Tone; key: MessageKey } {
  if (a.verdict === 'consult') return { tone: 'red', key: 'ai.b.consult' };
  if (a.verdict === 'spread') return { tone: 'yellow', key: a.reasons.overlap && !a.reasons.spread && !a.reasons.avoid ? 'ai.b.dose' : 'ai.b.spread' };
  return { tone: 'green', key: a.reasons.synergy ? 'ai.b.synergy' : 'ai.b.none' };
}

/** Evening, night or before sleep — the moon; everything else — the sun. */
export const isEvening = (when: string) => /вечер|ноч|сн[ае]|перед сном|kechqurun|kechki|kech|tun|uyqu/i.test(when);

/**
 * 3.8: VITALO AI in the cart (D-45, D-47; docs/releases/vitalo-ai.md, 2.1–2.5). One block on #F0F6FF: «Проверить
 * совместимость (VITALO AI)» (one product — «С чем сочетать этот препарат?»). The consent and the daily limit are checked
 * before the animation; then the 4 steps and the answer card. «Спросить специалиста лично» — in the answer, on the limit
 * and on an error.
 * Шаг 0а (D-66, D-68): the block is folded until it is tapped — no answer opens by itself, a cached one too. Under the
 * AI answer — «Есть ответ специалиста VITALO» (when there is one with the same label) and «Спросить специалиста».
 * D-70: «Спросить VITALO AI о корзине» (`onChat`) — under the answer and in the folded block.
 */
export function AiCompat({
  state,
  products,
  canAskSpecialist,
  onAsk,
  onChange,
  onRefuse,
  askConsent = false,
  setKey = '',
  items = [],
  onChat,
}: {
  state: AiState;
  products: string[];
  canAskSpecialist: boolean;
  onAsk: () => void;
  onChange: (next: AiState) => void;
  /** the consent window was closed without «Я согласен» */
  onRefuse: () => void;
  /** open the consent at once («Проверить с VITALO AI» after a refusal) */
  askConsent?: boolean;
  /** D-70: the set of the cart — «Корзина изменилась — сверить снова» and the answer kept for the same set */
  setKey?: string;
  /** D-70: thumbnails in the block and in the analysis */
  items?: AiCartItem[];
  /** D-70: «Спросить VITALO AI о корзине» */
  onChat?: () => void;
}) {
  const { t, lang } = useI18n();
  const [phase, setPhase] = useState<'idle' | 'consent' | 'checking'>(askConsent ? 'consent' : 'idle');
  const [note, setNote] = useState<Note | null>(null);
  const [ms, setMs] = useState(AI_MIN_MS.value);
  // Шаг 0а: the result appears only after the tap, on this screen
  const checked = readStore(session, CHECKED_KEY);
  const [shown, setShown] = useState(() => !!setKey && checked === setKey && !!state.answer);
  const changed = !!setKey && !!checked && checked !== setKey;

  const run = async (next0: AiState = state) => {
    setNote(null);
    // 3.8 fix: no animation when the answer cannot come — the limit is shown at once
    if (next0.left_today <= 0 && !next0.cached) return setNote('limit');
    const total = next0.cached ? AI_CACHED_MS.value : AI_MIN_MS.value;
    setMs(total);
    setPhase('checking');
    const started = Date.now();
    let next: AiState | null = null;
    let failed: Note | 'consent' | null = null;
    try {
      next = await api<AiState>('/compat/ai/check', { method: 'POST' });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      failed = code === 'AI_DAILY_LIMIT' ? 'limit' : code === 'CONSENT_REQUIRED' ? 'consent' : code === 'BUSY' ? null : 'failed';
    }
    // the limit or the consent turned out on the server: no point in finishing the animation
    if (failed !== 'limit' && failed !== 'consent') await wait(Math.max(0, total - (Date.now() - started)));
    if (failed === 'consent') return setPhase('consent');
    setPhase('idle');
    if (failed) setNote(failed);
    if (next) {
      onChange(next);
      if (next.answer || (next.result === 'instant' && next.specialist)) {
        setShown(true);
        if (setKey) writeStore(session, CHECKED_KEY, setKey);
      }
      if (next.result === 'specialist') setNote('fallback');
      if (next.result === 'unavailable') setNote('unavailable');
    }
  };

  const one = products.length === 1;
  const n = products.length;
  const heroId = useId();
  const title = one ? t('ai.checkOne') : changed ? t('ai.recheck') : t('ai.checkN', { n, goods: goodsWord(n, lang) });
  const chat = onChat && (
    <button type="button" className="ai-chat-btn" onClick={onChat}>
      <SparkIcon width={16} height={16} aria-hidden /> {t(one ? 'ai.chatOne' : 'ai.chat')}
    </button>
  );
  const ask = canAskSpecialist && (
    <button type="button" className="link ai-ask" onClick={onAsk}>
      {t('ai.askLive')}
    </button>
  );
  // two different labels side by side — never (архитектура 3.3): on a conflict only the AI answer is shown
  const specialist = state.specialist && !state.specialist.conflict ? state.specialist : null;
  return (
    <div className="ai-compat">
      {phase === 'checking' ? (
        <AiProgress ms={ms} items={items} count={n} />
      ) : shown && state.answer ? (
        <>
          <AiAnswerCard answer={state.answer} ask={ask} specialist={specialist} />
          {chat}
        </>
      ) : shown && state.specialist ? (
        // the AI could not answer and a saved specialist answer was given at once
        <SpecialistAnswer answer={state.specialist} />
      ) : (
        <section className="ai-box ai-hero">
          <div className="ai-hero-head">
            <span className="ai-spark" aria-hidden>
              <SparkIcon width={18} height={18} />
            </span>
            <span className="ai-box-text">
              <strong id={`${heroId}-t`}>{title}</strong>
              <span>{t('ai.sub')}</span>
            </span>
          </div>
          <button
            type="button"
            className="btn btn-sm ai-hero-check"
            aria-labelledby={`${heroId}-t ${heroId}-b`}
            onClick={() => (state.consent ? void run() : setPhase('consent'))}
          >
            <SparkIcon width={15} height={15} aria-hidden />
            <span id={`${heroId}-b`}>{t(one ? 'ai.checkBtnOne' : 'ai.checkBtn')}</span>
          </button>
          {chat}
          {note && (
            <div className={`ai-note${note === 'fallback' ? ' is-info' : ''}`} role="status">
              {note === 'fallback' ? <InfoIcon width={18} height={18} aria-hidden /> : <AlertIcon width={18} height={18} aria-hidden />}
              <span>
                {t(`ai.${note}` as MessageKey)}
                {note !== 'fallback' && ask}
              </span>
            </div>
          )}
        </section>
      )}
      {phase === 'consent' && (
        <AiConsentSheet
          onClose={() => {
            setPhase('idle');
            onRefuse();
          }}
          onAgreed={(next) => {
            onChange(next);
            void run(next);
          }}
        />
      )}
    </div>
  );
}

/**
 * The AI is off in «Настройки», there is no key, or the customer did not agree: the same block leads to the specialist
 * (3.4), with the way back to VITALO AI when it works.
 */
export function SpecialistBox({ onAsk, onTryAi }: { onAsk: () => void; onTryAi?: () => void }) {
  const { t } = useI18n();
  return (
    <section className="ai-box">
      <button type="button" className="ai-box-main" onClick={onAsk}>
        <span className="ai-box-text">
          <strong>
            <ShieldIcon width={16} height={16} aria-hidden /> {t('ai.askLive')}
          </strong>
          <span>{t('compat.hours')}</span>
        </span>
        <ChevronIcon className="ask-chevron" width={20} height={20} aria-hidden />
      </button>
      {onTryAi && (
        <button type="button" className="link ai-ask" onClick={onTryAi}>
          <SparkIcon width={14} height={14} aria-hidden /> {t('ai.tryAi')}
        </button>
      )}
    </section>
  );
}

/** D-70: the products of the cart in a row; `lit` — the one being checked now. */
function Thumbs({ items, lit = -1 }: { items: AiCartItem[]; lit?: number }) {
  return (
    <span className="ai-thumbs" aria-hidden>
      {items.slice(0, 6).map((p, i) => (
        <span key={p.product_id} className={`ai-thumb${i === lit ? ' is-lit' : ''}`}>
          {p.image_url ? <img src={p.image_url} alt="" width={36} height={36} loading="lazy" decoding="async" /> : <span>{p.name.slice(0, 1)}</span>}
        </span>
      ))}
      {items.length > 6 && <span className="ai-thumb ai-thumb-more">+{items.length - 6}</span>}
    </span>
  );
}

/**
 * A navy header, a soft shimmer and 4 steps ticked in turn; with reduced motion — all steps at once, no shimmer.
 * D-70: «Сверяю 3 товара…» and the products light up in turn.
 */
function AiProgress({ ms, items = [], count = 0 }: { ms: number; items?: AiCartItem[]; count?: number }) {
  const { t, lang } = useI18n();
  const still = reducedMotion();
  const [done, setDone] = useState(still ? STEPS.length : 0);
  useEffect(() => {
    if (still) return;
    const every = Math.max(150, ms / STEPS.length);
    const id = setInterval(() => setDone((d) => Math.min(STEPS.length, d + 1)), every);
    return () => clearInterval(id);
  }, [ms, still]);
  const [lit, setLit] = useState(0);
  useEffect(() => {
    if (still || items.length < 2) return;
    const id = setInterval(() => setLit((i) => (i + 1) % items.length), Math.max(250, ms / Math.max(items.length, 1)));
    return () => clearInterval(id);
  }, [ms, still, items.length]);
  return (
    <section className={`ai-progress${still ? '' : ' is-moving'}`} role="status" aria-live="polite">
      <header className="ai-head">
        <SparkIcon width={16} height={16} aria-hidden />
        <h3>{count > 1 ? t('ai.checking', { n: count, goods: goodsAcc(count, lang) }) : t('ai.progress')}</h3>
      </header>
      {items.length > 1 && (
        <div className="ai-progress-thumbs">
          <Thumbs items={items} lit={still ? -1 : lit} />
        </div>
      )}
      <ol className="ai-steps">
        {STEPS.map((key, i) => (
          <li key={key} className={i < done ? 'is-done' : i === done ? 'is-now' : ''}>
            <span className="ai-step-mark" aria-hidden>
              {i < done && <CheckIcon width={14} height={14} />}
            </span>
            {t(key)}
          </li>
        ))}
      </ol>
    </section>
  );
}

const VERDICT_KEY: Record<CompatVerdict, MessageKey> = { compatible: 'compat.v.compatible', spread: 'compat.v.spread', consult: 'compat.v.consult' };

/** Шаг 0а: the specialist answer itself — under the link, or alone when the AI could not answer. */
function SpecialistAnswer({ answer, withLabel = true }: { answer: { verdict: CompatVerdict; text: string }; withLabel?: boolean }) {
  const { t } = useI18n();
  return (
    <section className={`compat-answer is-${answer.verdict}`} aria-label={t('compat.instant')}>
      <div className="compat-answer-head">
        {withLabel && <span className={`compat-label is-${answer.verdict}`}>{t(VERDICT_KEY[answer.verdict])}</span>}
        <span className="compat-answer-title">{t('compat.instant')}</span>
      </div>
      <p className="compat-answer-text">{answer.text}</p>
      <p className="compat-disclaimer">{t('compat.disclaimer')}</p>
    </section>
  );
}

/** Шаг 0а: «Есть ответ специалиста VITALO» — a link that opens the answer under the AI one (no second badge). */
function SpecialistLink({ answer }: { answer: { verdict: CompatVerdict; text: string } }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="ai-specialist">
      <button
        type="button"
        className="link ai-specialist-link"
        aria-expanded={open}
        onClick={() => {
          if (!open) track('compat_view', { verdict: answer.verdict, source: 'specialist_link', changed: false });
          setOpen(!open);
        }}
      >
        <ShieldIcon width={14} height={14} aria-hidden /> {t(open ? 'ai.specialistHide' : 'ai.specialistLink')}
      </button>
      {open && <SpecialistAnswer answer={answer} withLabel={false} />}
    </div>
  );
}

function AiAnswerCard({ answer, ask, specialist }: { answer: AiAnswer; ask: ReactNode; specialist: { verdict: CompatVerdict; text: string } | null }) {
  const { t } = useI18n();
  const seen = useRef('');
  useEffect(() => {
    if (seen.current === answer.answer_id) return;
    seen.current = answer.answer_id;
    track('compat_view', { verdict: answer.verdict, source: 'ai', changed: false });
  }, [answer.answer_id, answer.verdict]);
  const badge = aiBadge(answer);
  const [folded, setFolded] = useState(() => readStore(local, FOLDED_KEY) === '1');
  const fold = () => {
    writeStore(local, FOLDED_KEY, folded ? null : '1');
    setFolded(!folded);
  };
  return (
    <section className="ai-answer" aria-label={t('ai.answerTitle')}>
      <header className="ai-head">
        <SparkIcon width={16} height={16} aria-hidden />
        <h3>{t('ai.answerTitle')}</h3>
        <span className={`ai-verdict is-${badge.tone}`}>{t(badge.key)}</span>
      </header>
      <button type="button" className="ai-fold" aria-expanded={!folded} onClick={fold}>
        <span>{t(folded ? 'ai.more' : 'ai.hide')}</span>
        <ChevronIcon className={`ai-fold-chevron${folded ? '' : ' is-open'}`} width={16} height={16} aria-hidden />
      </button>
      {!folded && (
      <div className="ai-answer-body">
        <p className="ai-answer-text">{answer.text}</p>
        {answer.overlaps.length > 0 && (
          <p className="ai-overlap">
            <AlertIcon width={14} height={14} aria-hidden /> {t('ai.overlap', { names: answer.overlaps.join(', ') })}
          </p>
        )}
        {answer.timing.length > 0 && (
          <>
            <h4 className="ai-sub">{t('ai.timing')}</h4>
            <ul className="ai-timing">
              {answer.timing.map((x) => (
                <li key={x.product_id}>
                  {isEvening(x.when) ? <MoonIcon width={16} height={16} aria-hidden /> : <SunIcon width={16} height={16} aria-hidden />}
                  <span className="ai-timing-name">{x.name}</span>
                  <span className="ai-timing-when">{x.when}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {answer.suggestions.length > 0 && (
          <>
            <h4 className="ai-sub">{t('ai.suggest')}</h4>
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
        </div>
        <p className="compat-disclaimer">{t('compat.disclaimer')}</p>
        {specialist && <SpecialistLink answer={specialist} />}
        {ask}
      </div>
      )}
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
