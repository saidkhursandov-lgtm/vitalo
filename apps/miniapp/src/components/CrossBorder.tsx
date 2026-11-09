import { useI18n, type MessageKey } from '../lib/i18n';
import type { CbStage, CrossBorderTracking, CrossBorderWindow, Lang, Order, UnderOrderMark, UnderOrderTerms } from '../lib/types';
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

/** «7–14 дней», «1–2 дня», «5 дней» / «7–14 kun». */
export function daysRange(min: number, max: number, lang: Lang): string {
  const n = min === max ? `${max}` : `${min}–${max}`;
  if (lang === 'uz') return `${n} kun`;
  const d = max % 10 === 1 && max % 100 !== 11 ? 'дня' : max % 10 >= 2 && max % 10 <= 4 && (max % 100 < 12 || max % 100 > 14) ? 'дня' : 'дней';
  return `${n} ${d}`;
}

/**
 * D-61: the text of a «под заказ» thing by its supplier — usa.* with {src} «из США» / {Src} «Из США» for a foreign one
 * (no kind: an older answer, from the USA), local.* for a Tashkent supplier.
 */
export function useUnderOrderText() {
  const { t, lang } = useI18n();
  return (key: string, m: UnderOrderMark | null | undefined, params: Record<string, string | number> = {}) => {
    if (m?.kind === 'local') return t(`local.${key}` as MessageKey, params);
    const src = (lang === 'uz' ? m?.from_uz : m?.from_ru) || (lang === 'uz' ? 'AQShdan' : 'из США');
    return t(`usa.${key}` as MessageKey, { ...params, src, Src: src.charAt(0).toUpperCase() + src.slice(1) });
  };
}

/** «Под заказ из США • 7–14 дней» / «Под заказ • 1–2 дня» */
export function useUnderOrderDays() {
  const { lang } = useI18n();
  const uo = useUnderOrderText();
  return (terms: UnderOrderTerms | null | undefined) => uo('days', terms, { range: daysRange(terms?.days_min ?? 7, terms?.days_max ?? 14, lang) });
}

/** A small «Из США» / «Под заказ» mark next to a line in the cart, the checkout and the order. */
export function UsaBadge({ mark }: { mark?: UnderOrderMark | null }) {
  const uo = useUnderOrderText();
  return (
    <span className="usa-badge">
      {mark?.kind !== 'local' && <PlaneIcon width={14} height={14} />}
      {uo('badge', mark)}
    </span>
  );
}

/** D-60: before the payment — when it comes, that everything comes together, prepayment only (abroad), cancel and money back. */
export function UsaWindowNotice({ window: w }: { window: CrossBorderWindow }) {
  const { lang } = useI18n();
  const uo = useUnderOrderText();
  // a foreign line in the order — the «из США» texts (prepayment only); only local lines — «под заказ»
  const mark: UnderOrderMark = w.foreign === false ? { kind: 'local' } : { kind: 'foreign', from_ru: w.from_ru, from_uz: w.from_uz };
  return (
    <div className="usa-notice" role="note">
      {mark.kind !== 'local' && <PlaneIcon width={20} height={20} />}
      <div>
        <strong>{uo('noticeTitle', mark, { dates: dateRange(w.expected_from, w.expected_to, lang) })}</strong>
        <p className="small">{uo('noticeText', mark, { days: w.guarantee_days })}</p>
      </div>
    </div>
  );
}

/** The stage name for the order list and the home plaque («Отправлен из США», «Заказан у поставщика»). */
export function useUsaStageLabel() {
  const { t } = useI18n();
  const uo = useUnderOrderText();
  return (s: CbStage, m?: UnderOrderMark | null) => (s === 'ordered' || s === 'shipped' ? uo(`stage.${s}`, m) : t(`usa.stage.${s}` as MessageKey));
}

/**
 * D-60: «Где ваш заказ из США» on the order screen — the promised window, every stage with its date, the moved dates
 * with their reasons and when the customer may cancel by themselves.
 */
export function UsaTracking({ tracking, cancel }: { tracking: CrossBorderTracking; cancel?: Order['cross_border_cancel'] }) {
  const { t, lang } = useI18n();
  const uo = useUnderOrderText();
  const stageLabel = useUsaStageLabel();
  const done = tracking.stage === 'in_stock';
  const title = uo('trackingTitle', tracking);
  return (
    <section className="card usa-tracking" aria-label={title}>
      <h2>{title}</h2>
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
                <span>{stageLabel(s.stage, tracking)}</span>
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
            ? uo(cancel.reason === 'guarantee' ? 'cancelGuarantee' : 'cancelBeforeOrder', tracking)
            : cancel.guarantee_date && uo('cancelFrom', tracking, { date: dayMonth(cancel.guarantee_date, lang) })}
        </p>
      )}
    </section>
  );
}
