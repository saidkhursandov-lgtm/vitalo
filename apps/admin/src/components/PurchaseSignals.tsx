/**
 * Генплан, этап 5 (D-57, решение владельца 09.11): purchase signals A («Выгодный закуп на iHerb») and B («Перехват в
 * Ташкенте»), computed by the API. Icons are SVG (D-19: no emoji).
 */

export type SignalKind = 'iherb_buy' | 'iherb_strong' | 'local_urgent' | 'local_intercept';

export interface PurchaseSignal {
  kind: SignalKind;
  text: string;
  pct: number;
}

const TONE: Record<SignalKind, string> = {
  iherb_buy: 'ok',
  iherb_strong: 'ok',
  local_urgent: 'warn',
  local_intercept: 'info',
};

export const SIGNAL_TITLES: Record<SignalKind, string> = {
  iherb_buy: 'Выгодный закуп на iHerb',
  iherb_strong: 'Сильная просадка на iHerb',
  local_urgent: 'Срочно брать в Ташкенте',
  local_intercept: 'Выгодно перехватить в Ташкенте',
};

/** A falling arrow for iHerb (rule A), a lightning bolt for Tashkent (rule B). */
function SignalIcon({ kind }: { kind: SignalKind }) {
  const iherb = kind === 'iherb_buy' || kind === 'iherb_strong';
  return (
    <svg className="signal-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      {iherb ? (
        <path d="M2 4l4.5 4.5 2.5-2.5L14 11M14 11V7.5M14 11h-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" fill="currentColor" />
      )}
    </svg>
  );
}

/** Short chips (the list of products). */
export function SignalChips({ signals }: { signals: PurchaseSignal[] }) {
  if (!signals.length) return null;
  return (
    <span className="signal-chips">
      {signals.map((s) => (
        <span key={s.kind} className={`badge badge-${TONE[s.kind]} signal-chip`} title={s.text}>
          <SignalIcon kind={s.kind} />
          {SIGNAL_TITLES[s.kind]}
        </span>
      ))}
    </span>
  );
}

/** Full sentences (the product chart and the «Сигналы закупки» card). */
export function SignalList({ signals }: { signals: PurchaseSignal[] }) {
  if (!signals.length) return null;
  return (
    <ul className="signal-list">
      {signals.map((s) => (
        <li key={s.kind} className={`alert alert-${TONE[s.kind]} signal-line`}>
          <SignalIcon kind={s.kind} />
          <span>{s.text}</span>
        </li>
      ))}
    </ul>
  );
}
