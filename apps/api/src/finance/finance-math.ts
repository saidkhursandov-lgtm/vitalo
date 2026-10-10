/**
 * Stage 3: the one way money is counted (analytics, tax, payroll). Pure functions over «sale events», so the same
 * numbers appear everywhere and the channels always add up to the total. All amounts: whole UZS.
 *
 * A sale is recognised on the day the order became «Доставлен» (S3-3). A return of a delivered order is a second
 * event on the day of the return with the opposite sign: it takes the revenue, the commission and the cost of the
 * units back in the month of the return — the month of the sale is never rewritten.
 */

export type Channel = 'yandex' | 'vitalo';
export const CHANNELS: Channel[] = ['yandex', 'vitalo'];

export interface SaleLine {
  product_id: string;
  sku: string;
  name: string;
  qty: number;
  /** price of the sold goods (Mini App: what was paid for the goods, without the customer's delivery) */
  revenue: number;
  /** cost snapshot of the very units; null = unknown (old orders without units, products without unit tracking) */
  cost: number | null;
  /** Yandex commission of this line (0 for the Mini App) */
  commission: number;
}

export interface SaleEvent {
  channel: Channel;
  order_id: string;
  number: string;
  /** Tashkent day, YYYY-MM-DD */
  day: string;
  /** +1 sale, −1 return */
  sign: 1 | -1;
  lines: SaleLine[];
  /** what the delivery cost us (counted with the sale only: a return does not give it back) */
  own_delivery: number;
}

// ---------------------------------------------------------------- months

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const monthOfDay = (day: string) => day.slice(0, 7);

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Inclusive list of months. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export const firstDay = (month: string) => `${month}-01`;
export const lastDay = (month: string) => `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;

/** Tax and salaries of a month are due on the 14th of the next month (S3-5, S3-6). */
export const dueDay = (month: string) => `${addMonths(month, 1)}-14`;

/** How many days of the month lie inside [from, to] (inclusive days). */
export function overlapDays(month: string, from: string, to: string): number {
  const a = from > firstDay(month) ? from : firstDay(month);
  const b = to < lastDay(month) ? to : lastDay(month);
  if (a > b) return 0;
  return Number(b.slice(8, 10)) - Number(a.slice(8, 10)) + 1;
}

// ---------------------------------------------------------------- rates

export interface RateFrom {
  /** YYYY-MM the value is valid from */
  from: string;
  value: number;
}

/** The value valid in the month: the latest entry that starts not later than it (null before the first one). */
export function valueFor(entries: RateFrom[], month: string): number | null {
  const ok = entries.filter((e) => e.from <= month).sort((a, b) => a.from.localeCompare(b.from));
  return ok.length ? ok[ok.length - 1].value : null;
}

/** Tax of a turnover: never negative (a month with more returns than sales owes nothing). */
export const taxOf = (turnover: number, percent: number) => Math.max(0, Math.round((turnover * percent) / 100));

// ---------------------------------------------------------------- summary

export interface Totals {
  revenue: number;
  /** known cost of the units sold */
  cost: number;
  /** revenue of the lines whose cost is unknown («себестоимость неизвестна») */
  revenue_without_cost: number;
  commission: number;
  delivery: number;
  tax: number;
  /** revenue − cost − commission − delivery − tax (for a channel: before the shared expenses) */
  profit: number;
  orders: number;
  units: number;
}

const zero = (): Totals => ({ revenue: 0, cost: 0, revenue_without_cost: 0, commission: 0, delivery: 0, tax: 0, profit: 0, orders: 0, units: 0 });

export interface ProductRow {
  product_id: string;
  sku: string;
  name: string;
  qty: number;
  revenue: number;
  cost: number;
  revenue_without_cost: number;
  commission: number;
  /** revenue − cost − commission; when a part of the cost is unknown the profit is «неполная» */
  profit: number;
  margin_percent: number | null;
  incomplete: boolean;
}

export interface Summary {
  channels: Record<Channel, Totals>;
  /** both channels together (equals the sum of the channel rows field by field) */
  sales: Totals;
  other_expenses: number;
  salaries: number;
  /** sales.profit − other expenses − salaries */
  net_profit: number;
  /** some sold goods have no known cost: the profit is higher than the real one */
  incomplete: boolean;
  products: ProductRow[];
}

/**
 * Events inside [from, to] (days, inclusive) → totals per channel, the total and the product table.
 * Tax: per month and per channel, round(turnover × rate), never negative; the total is the SUM of the channel
 * values, so the channels always add up (the «Налог» screen uses the same function).
 */
export function summarize(
  events: SaleEvent[],
  opts: { from: string; to: string; taxRates: RateFrom[]; otherExpenses: number; salaries: number; channel?: Channel | null },
): Summary {
  const channels: Record<Channel, Totals> = { yandex: zero(), vitalo: zero() };
  const turnover = new Map<string, number>(); // `${channel}|${month}`
  const products = new Map<string, ProductRow>();
  for (const e of events) {
    if (e.day < opts.from || e.day > opts.to) continue;
    if (opts.channel && e.channel !== opts.channel) continue;
    const t = channels[e.channel];
    t.orders += e.sign;
    if (e.sign === 1) t.delivery += e.own_delivery;
    for (const l of e.lines) {
      t.revenue += e.sign * l.revenue;
      t.commission += e.sign * l.commission;
      t.units += e.sign * l.qty;
      if (l.cost === null) t.revenue_without_cost += e.sign * l.revenue;
      else t.cost += e.sign * l.cost;
      const key = `${e.channel}|${monthOfDay(e.day)}`;
      turnover.set(key, (turnover.get(key) ?? 0) + e.sign * l.revenue);

      const p = products.get(l.product_id) ?? { product_id: l.product_id, sku: l.sku, name: l.name, qty: 0, revenue: 0, cost: 0, revenue_without_cost: 0, commission: 0, profit: 0, margin_percent: null, incomplete: false };
      p.qty += e.sign * l.qty;
      p.revenue += e.sign * l.revenue;
      p.commission += e.sign * l.commission;
      if (l.cost === null) p.revenue_without_cost += e.sign * l.revenue;
      else p.cost += e.sign * l.cost;
      products.set(l.product_id, p);
    }
  }
  for (const [key, value] of turnover) {
    const [channel, month] = key.split('|') as [Channel, string];
    channels[channel].tax += taxOf(value, valueFor(opts.taxRates, month) ?? 0);
  }
  const sales = zero();
  for (const c of CHANNELS) {
    const t = channels[c];
    t.profit = t.revenue - t.cost - t.commission - t.delivery - t.tax;
    for (const k of Object.keys(sales) as (keyof Totals)[]) sales[k] += t[k];
  }
  const rows = [...products.values()]
    .map((p) => {
      const profit = p.revenue - p.cost - p.commission;
      return { ...p, profit, incomplete: p.revenue_without_cost !== 0, margin_percent: p.revenue > 0 ? Math.round((profit / p.revenue) * 1000) / 10 : null };
    })
    .filter((p) => p.qty !== 0 || p.revenue !== 0)
    .sort((a, b) => b.revenue - a.revenue);
  return {
    channels,
    sales,
    other_expenses: opts.otherExpenses,
    salaries: opts.salaries,
    net_profit: sales.profit - opts.otherExpenses - opts.salaries,
    incomplete: sales.revenue_without_cost !== 0,
    products: rows,
  };
}

/** Turnover of each month per channel (sales − returns of that month), for the «Налог» screen. */
export function turnoverByMonth(events: SaleEvent[]): Map<string, Record<Channel, number>> {
  const out = new Map<string, Record<Channel, number>>();
  for (const e of events) {
    const m = monthOfDay(e.day);
    const row = out.get(m) ?? { yandex: 0, vitalo: 0 };
    for (const l of e.lines) row[e.channel] += e.sign * l.revenue;
    out.set(m, row);
  }
  return out;
}

/** Tax of a month: the sum of the channel taxes (the same rounding as summarize). */
export const monthTax = (t: Record<Channel, number>, percent: number) => taxOf(t.yandex, percent) + taxOf(t.vitalo, percent);

/** Salaries accrued inside [from, to]: each month's amount in proportion to its days inside the period. */
export function salariesInPeriod(accruals: { month: string; amount: number }[], from: string, to: string): number {
  let sum = 0;
  for (const a of accruals) {
    const days = overlapDays(a.month, from, to);
    if (days) sum += Math.round((a.amount * days) / daysInMonth(a.month));
  }
  return sum;
}

/** Months an employee is paid for, up to `until` (inclusive), with the amount valid in each. */
export function accrualsOf(e: { start_month: string; end_month: string | null; rates: RateFrom[] }, until: string): { month: string; amount: number }[] {
  const last = e.end_month && e.end_month < until ? e.end_month : until;
  if (e.start_month > last) return [];
  return monthsBetween(e.start_month, last).map((month) => ({ month, amount: valueFor(e.rates, month) ?? 0 }));
}

export type PayStatus = 'paid' | 'due' | 'overdue';
/** к выплате until the 14th of the next month, просрочено after it. */
export const payStatus = (month: string, paid: boolean, today: string): PayStatus => (paid ? 'paid' : today > dueDay(month) ? 'overdue' : 'due');
