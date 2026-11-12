import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useI18n, type MessageKey } from '../lib/i18n';
import type { AiGoalAnswer, AiGoalFit } from '../lib/types';
import { ChevronIcon, InfoIcon, ShieldIcon, SparkIcon } from './Icons';

/** The same chips as the API (apps/api/src/compat/ai-goal.ts). */
export const GOALS = ['sleep', 'stress', 'energy', 'joints', 'immunity', 'sport'] as const;
type Goal = (typeof GOALS)[number];
const DURATIONS = ['lt2w', '2to4w', 'gt1m'] as const;
const KINDS: Record<Goal, readonly string[]> = {
  sleep: ['fall_asleep', 'wake_night', 'not_rested'],
  stress: ['tension', 'irritability', 'restless'],
  energy: ['morning', 'afternoon', 'all_day'],
  joints: ['stiffness', 'after_load', 'support'],
  immunity: ['often_colds', 'season', 'recovery'],
  sport: ['strength', 'endurance', 'recovery'],
};
const FIT_TONE: Record<AiGoalFit, 'green' | 'yellow' | 'grey'> = { helps: 'green', maybe: 'yellow', unlikely: 'grey', no_data: 'grey' };

type Step = 'intro' | 'goal' | 'duration' | 'kind' | 'loading' | 'answer';
type Failure = 'limit' | 'failed';

/**
 * Шаг 0б (D-68, D-69; архитектура 3.3, 3.6): «Задать вопрос VITALO AI по корзине» under the AI answer. Folded by
 * default and only chips: «Поможет ли этот набор для моей цели?» → the goal → how long → what exactly → the answer
 * (А–Б–В): a line per product with the level in words from our base, general steps, the doctor line and «Спросить
 * специалиста VITALO». Only the chosen chips and the cart go to the model — the customer types nothing.
 */
export function AiGoalBlock({ canAskSpecialist, onAsk }: { canAskSpecialist: boolean; onAsk: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('intro');
  const [goal, setGoal] = useState<Goal | null>(null);
  const [duration, setDuration] = useState<string | null>(null);
  const [answer, setAnswer] = useState<AiGoalAnswer | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const send = async (kind: string) => {
    setStep('loading');
    setFailure(null);
    try {
      setAnswer(await api<AiGoalAnswer>('/compat/ai/goal', { method: 'POST', body: { goal, duration, kind } }));
      setStep('answer');
    } catch (e) {
      setFailure(e instanceof ApiError && e.code === 'AI_DAILY_LIMIT' ? 'limit' : 'failed');
      setStep('kind');
    }
  };
  const again = () => {
    setGoal(null);
    setDuration(null);
    setAnswer(null);
    setFailure(null);
    setStep('goal');
  };
  const specialist = canAskSpecialist ? (
    <button type="button" className="link ai-ask" onClick={onAsk}>
      <ShieldIcon width={14} height={14} aria-hidden /> {t('ai.goal.specialist')}
    </button>
  ) : (
    <Link to="/support" className="link ai-ask">
      <ShieldIcon width={14} height={14} aria-hidden /> {t('ai.goal.specialist')}
    </Link>
  );
  const chips = (keys: readonly string[], label: (k: string) => string, pick: (k: string) => void) => (
    <div className="chips wrap ai-goal-chips">
      {keys.map((k) => (
        <button key={k} type="button" className="chip" onClick={() => pick(k)}>
          {label(k)}
        </button>
      ))}
    </div>
  );

  return (
    <section className="ai-goal">
      <button type="button" className="ai-goal-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <SparkIcon width={16} height={16} aria-hidden />
        <span>{t('ai.goal.toggle')}</span>
        <ChevronIcon className={`ai-goal-chevron${open ? ' is-open' : ''}`} width={18} height={18} aria-hidden />
      </button>
      {open && (
        <div className="ai-goal-body">
          {step === 'intro' && chips(['ask'], () => t('ai.goal.ask'), () => setStep('goal'))}
          {step === 'goal' && (
            <>
              <p className="ai-goal-q">{t('ai.goal.qGoal')}</p>
              {chips(GOALS, (g) => t(`ai.goal.g.${g}` as MessageKey), (g) => {
                setGoal(g as Goal);
                setStep('duration');
              })}
            </>
          )}
          {step === 'duration' && goal && (
            <>
              <p className="ai-goal-q">{t('ai.goal.qDuration')}</p>
              {chips(DURATIONS, (d) => t(`ai.goal.d.${d}` as MessageKey), (d) => {
                setDuration(d);
                setStep('kind');
              })}
            </>
          )}
          {step === 'kind' && goal && (
            <>
              <p className="ai-goal-q">{t('ai.goal.qKind')}</p>
              {chips(KINDS[goal], (k) => t(`ai.goal.k.${k}` as MessageKey), (k) => void send(k))}
              {failure && (
                <div className="ai-note" role="status">
                  <InfoIcon width={18} height={18} aria-hidden />
                  <span>
                    {t(failure === 'limit' ? 'ai.goal.limit' : 'ai.goal.failed')}
                    {specialist}
                  </span>
                </div>
              )}
            </>
          )}
          {step === 'loading' && (
            <p className="ai-goal-loading" role="status" aria-live="polite">
              {t('ai.goal.loading')}
            </p>
          )}
          {step === 'answer' && answer && (
            <div className="ai-goal-answer" role="region" aria-label={t('ai.goal.title')}>
              <h4 className="ai-sub">
                {t('ai.goal.title')}: {t(`ai.goal.g.${answer.goal}` as MessageKey).toLowerCase()}
              </h4>
              <p className="ai-answer-text">{answer.summary}</p>
              <ul className="ai-goal-products">
                {answer.products.map((p) => (
                  <li key={p.product_id}>
                    <div className="ai-goal-product-head">
                      <span className="ai-goal-name">{p.name}</span>
                      <span className={`ai-verdict is-${FIT_TONE[p.fit]}`}>{t(`ai.goal.fit.${p.fit}` as MessageKey)}</span>
                    </div>
                    {p.level_text && <span className="ai-goal-level">{p.level_text}</span>}
                    <p className="ai-goal-text">{p.text}</p>
                  </li>
                ))}
              </ul>
              <h4 className="ai-sub">{t('ai.goal.steps')}</h4>
              <ul className="ai-goal-steps">
                {answer.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              <p className="ai-goal-doctor">{answer.doctor}</p>
              {specialist}
              <p className="compat-disclaimer">{t('compat.disclaimer')}</p>
              <button type="button" className="link ai-ask" onClick={again}>
                {t('ai.goal.again')}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
