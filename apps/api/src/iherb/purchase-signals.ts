/**
 * Генплан, этап 5 (D-57, решение владельца 09.11): purchase signals for the buyer.
 *
 * «Закупка iHerb (с доставкой)» = iHerb price + weight × shipping rate per kg (0 by default: the owner fills baskets
 * up to the free delivery threshold).
 *
 * Rule A «Выгодный закуп на iHerb»: the landed cost now is X% or more below its 30-day average. The average is by days:
 * first the average of each Tashkent day, then the average of those days, so three uploads a day weigh as one day.
 * Rule B «Перехват в Ташкенте»: the lowest «1-в-1» price in Uzbekistan is not above the landed cost («срочно»), or
 * above it by not more than Y% («выгодно»: no 7–14 days of waiting).
 */

export interface SignalSettings {
  shipping_rate_per_kg_uzs: number;
  /** Rule A: the drop below the 30-day average that lights the signal, % */
  signal_a_pct: number;
  /** Rule A: the drop that is «сильная просадка», % */
  signal_a_strong_pct: number;
  /** Rule B: «близко к закупке» = the local price is above the landed cost by not more than this, % */
  signal_b_pct: number;
}

export const SIGNAL_DEFAULTS: SignalSettings = { shipping_rate_per_kg_uzs: 0, signal_a_pct: 10, signal_a_strong_pct: 15, signal_b_pct: 7 };

/** Rule A needs some history: with fewer days the «average» is mostly today's price. */
export const AVG_MIN_DAYS = 3;
export const AVG_DAYS = 30;

export interface SnapshotPoint {
  taken_at: Date;
  price_uzs: number;
  weight_kg: number | null;
  in_stock: boolean;
}

export type SignalKind = 'iherb_buy' | 'iherb_strong' | 'local_urgent' | 'local_intercept';

export interface PurchaseSignal {
  kind: SignalKind;
  /** Plain words for the admin panel. */
  text: string;
  /** Rule A: how far below the average, %; rule B: the local price above (+) or below (−) the landed cost, %. */
  pct: number;
}

export interface SignalResult {
  landed_uzs: number | null;
  /** the shipping rate is set but the iHerb weight is unknown: the landed cost has no delivery in it */
  weight_missing: boolean;
  avg30_uzs: number | null;
  avg_days: number;
  signals: PurchaseSignal[];
}

const TASHKENT_MS = 5 * 3600_000;
const dayOf = (d: Date) => new Date(d.getTime() + TASHKENT_MS).toISOString().slice(0, 10);
const pct1 = (n: number) => Math.round(n * 10) / 10;
const money = (n: number) => `${Math.round(n).toLocaleString('ru-RU').replace(/ /g, ' ')} сум`;

export function landedCost(price: number, weightKg: number | null, rate: number): number {
  return Math.round(price + (weightKg ?? 0) * rate);
}

/** The average of the daily averages of the landed cost in the last `days` days (`now` included). */
export function dailyAverage(points: SnapshotPoint[], rate: number, now: Date, days = AVG_DAYS): { avg: number | null; days: number } {
  const from = now.getTime() - days * 86400_000;
  const byDay = new Map<string, number[]>();
  for (const p of points) {
    if (p.taken_at.getTime() < from || p.taken_at.getTime() > now.getTime()) continue;
    const k = dayOf(p.taken_at);
    byDay.set(k, [...(byDay.get(k) ?? []), landedCost(p.price_uzs, p.weight_kg, rate)]);
  }
  if (!byDay.size) return { avg: null, days: 0 };
  const daily = [...byDay.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  return { avg: Math.round(daily.reduce((a, b) => a + b, 0) / daily.length), days: daily.length };
}

/**
 * Both rules for one product. `points` — its iHerb snapshots (any order, at least the last 30 days); `marketMin` — the
 * lowest «1-в-1» price in Uzbekistan and where it is.
 */
export function purchaseSignals(
  points: SnapshotPoint[],
  marketMin: { price_uzs: number; where: string } | null,
  s: SignalSettings,
  now = new Date(),
): SignalResult {
  const last = [...points].sort((a, b) => b.taken_at.getTime() - a.taken_at.getTime())[0];
  if (!last) return { landed_uzs: null, weight_missing: false, avg30_uzs: null, avg_days: 0, signals: [] };
  const landed = landedCost(last.price_uzs, last.weight_kg, s.shipping_rate_per_kg_uzs);
  const { avg, days } = dailyAverage(points, s.shipping_rate_per_kg_uzs, now);
  const signals: PurchaseSignal[] = [];

  // A: only when iHerb has it (an out-of-stock price cannot be bought)
  if (avg && days >= AVG_MIN_DAYS && last.in_stock) {
    const drop = pct1(((avg - landed) / avg) * 100);
    if (drop >= s.signal_a_strong_pct) signals.push({ kind: 'iherb_strong', pct: drop, text: `Сильная просадка на iHerb: −${drop}% от средней за 30 дней (${money(avg)})` });
    else if (drop >= s.signal_a_pct) signals.push({ kind: 'iherb_buy', pct: drop, text: `Выгодный закуп на iHerb: −${drop}% от средней за 30 дней (${money(avg)})` });
  }

  // B
  if (marketMin) {
    const diff = pct1(((marketMin.price_uzs - landed) / landed) * 100);
    if (marketMin.price_uzs <= landed) {
      signals.push({ kind: 'local_urgent', pct: diff, text: `Срочно брать в Ташкенте: ${marketMin.where} — ${money(marketMin.price_uzs)}, дешевле закупки на iHerb (${money(landed)})` });
    } else if (diff <= s.signal_b_pct) {
      signals.push({ kind: 'local_intercept', pct: diff, text: `Выгодно перехватить в Ташкенте: ${marketMin.where} — ${money(marketMin.price_uzs)}, дороже iHerb всего на ${diff}%, без ожидания 7–14 дней` });
    }
  }

  return { landed_uzs: landed, weight_missing: s.shipping_rate_per_kg_uzs > 0 && last.weight_kg == null, avg30_uzs: avg, avg_days: days, signals };
}
