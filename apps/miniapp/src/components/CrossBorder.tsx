import { useI18n, type MessageKey } from '../lib/i18n';
import type { CbStage, CrossBorderTracking, CrossBorderWindow, Lang, Order } from '../lib/types';
import { CheckIcon, PlaneIcon, USA_STAGE_ICONS } from './Icons';

const MONTHS: Record<Lang, string[]> = {
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  uz: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'],
};

/** «16 ноября» / «16-noyabr» from «2026-11-16». */
export function dayMonth(iso: string, lang: Lang): string {
  const d = Number(iso.slice(8, 10));
  const m = MONTHS[lang][Number(iso.slice(5, 7)) - 1];
  return lang === 'uz' ? `${d}-${m}` : `${d} ${m}`;
}

/** «16–23 ноября», «28 ноября – 5 декабря», or one day. */
export function dateRange(from: string | null, to: string, lang: Lang): string {
  if (!from || from === to) return dayMonth(to, lang);
  if (from.slice(0, 7) === to.slice(0, 7)) {
    return lang === 'uz' ? `${Number(from.slice(8, 10))}–${dayMonth(to, lang)}` : `${Number(from.slice(8, 10))}–${dayMonth(to, lang)}`;
  }
  return `${dayMonth(from, lang)} – ${dayMonth(to, lang)}`;
}

/** Tashkent date of a timestamp as «2026-11-16». */
const tashkentIso = (at: string) => new Date(new Date(at).getTime() + 5 * 3600_000).toISOString().slice(0, 10);

/** A small «Из США» mark next to a line in the cart, the checkout and the order. */
export function UsaBadge() {
  const { t } = useI18n();
  return (
    <span className="usa-badge">
      <PlaneIcon width={14} height={14} />
      {t('usa.badge')}
    </span>
  );
}

/** D-60: before the payment — when it comes, that everything comes together, prepayment only, cancel and money back. */
export function UsaWindowNotice({ window: w }: { window: CrossBorderWindow }) {
  const { t, lang } = useI18n();
  return (
    <div className="usa-notice" role="note">
      <PlaneIcon width={20} height={20} />
      <div>
        <strong>{t('usa.noticeTitle', { dates: dateRange(w.expected_from, w.expected_to, lang) })}</strong>
        <p className="small">{t('usa.noticeText', { days: w.guarantee_days })}</p>
      </div>
    </div>
  );
}

const stageLabel = (t: ReturnType<typeof useI18n>['t'], s: CbStage) => t(`usa.stage.${s}` as MessageKey);

/** The stage name for the order list and the home plaque («Отправлен из США»). */
export function useUsaStageLabel() {
  const { t } = useI18n();
  return (s: CbStage) => stageLabel(t, s);
}

/**
 * D-60: «Где ваш заказ из США» on the order screen — the promised window, every stage with its date, the moved dates
 * with their reasons and when the customer may cancel by themselves.
 */
export function UsaTracking({ tracking, cancel }: { tracking: CrossBorderTracking; cancel?: Order['cross_border_cancel'] }) {
  const { t, lang } = useI18n();
  const done = tracking.stage === 'in_stock';
  return (
    <section className="card usa-tracking" aria-label={t('usa.trackingTitle')}>
      <h2>{t('usa.trackingTitle')}</h2>
      {tracking.expected_to && !done && (
        <p className="usa-eta">
          {t('usa.expected')} <strong>{dateRange(tracking.expected_from, tracking.expected_to, lang)}</strong>
        </p>
      )}
      <ol className="usa-steps">
        {tracking.steps.map((s) => {
          const I = USA_STAGE_ICONS[s.stage];
          const current = s.stage === tracking.stage && !done;
          return (
            <li key={s.stage} className={`usa-step${s.done ? ' is-done' : ''}${current ? ' is-current' : ''}`}>
              <span className="usa-step-dot">{s.done ? <CheckIcon width={14} height={14} /> : I && <I width={14} height={14} />}</span>
              <span className="usa-step-text">
                <span>{stageLabel(t, s.stage)}</span>
                {s.at && <small className="hint">{dayMonth(tashkentIso(s.at), lang)}</small>}
              </span>
            </li>
          );
        })}
      </ol>
      {tracking.delays.length > 0 && (
        <ul className="usa-delays">
          {tracking.delays.map((d) => (
            <li key={d.at} className="small">
              {t('usa.delay', { date: d.expected_to ? dayMonth(d.expected_to, lang) : '—' })}
              {d.reason && <span className="hint"> {t('usa.delayReason', { reason: d.reason })}</span>}
            </li>
          ))}
        </ul>
      )}
      {cancel && !done && (
        <p className="hint small">
          {cancel.allowed
            ? t(cancel.reason === 'guarantee' ? 'usa.cancelGuarantee' : 'usa.cancelBeforeOrder')
            : cancel.guarantee_date && t('usa.cancelFrom', { date: dayMonth(cancel.guarantee_date, lang) })}
        </p>
      )}
    </section>
  );
}
