import { accrualsOf, addMonths, dueDay, monthTax, overlapDays, payStatus, salariesInPeriod, summarize, taxOf, turnoverByMonth, valueFor, type SaleEvent } from './finance-math';
import { reminderFor } from './finance-reminders.service';

const line = (over: Partial<SaleEvent['lines'][number]> = {}) => ({ product_id: 'p1', sku: 'A-1', name: 'Товар', qty: 1, revenue: 100_000, cost: 30_000 as number | null, commission: 0, ...over });
const ev = (over: Partial<SaleEvent> = {}): SaleEvent => ({ channel: 'vitalo', order_id: 'o', number: 'N', day: '2026-11-10', sign: 1, lines: [line()], own_delivery: 0, ...over });
const RATE = [{ from: '2000-01', value: 1 }];

describe('finance-math: months', () => {
  it('addMonths crosses the year; the due day is the 14th of the next month', () => {
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2027-01', -1)).toBe('2026-12');
    expect(dueDay('2026-11')).toBe('2026-12-14');
    expect(dueDay('2026-12')).toBe('2027-01-14');
  });

  it('overlapDays and salaries in proportion to the days of the period', () => {
    expect(overlapDays('2026-11', '2026-11-01', '2026-11-30')).toBe(30);
    expect(overlapDays('2026-11', '2026-11-16', '2026-12-31')).toBe(15);
    expect(overlapDays('2026-11', '2026-12-01', '2026-12-31')).toBe(0);
    expect(salariesInPeriod([{ month: '2026-11', amount: 400_000 }], '2026-11-01', '2026-11-30')).toBe(400_000);
    expect(salariesInPeriod([{ month: '2026-11', amount: 400_000 }], '2026-11-01', '2026-11-15')).toBe(200_000);
  });

  it('valueFor: the latest entry that started; null before the first', () => {
    const rates = [{ from: '2026-11', value: 400_000 }, { from: '2027-02', value: 500_000 }];
    expect(valueFor(rates, '2026-10')).toBeNull();
    expect(valueFor(rates, '2027-01')).toBe(400_000);
    expect(valueFor(rates, '2027-02')).toBe(500_000);
  });

  it('accruals start with the start month and keep the amount of each month', () => {
    const e = { start_month: '2026-11', end_month: null, rates: [{ from: '2026-11', value: 400_000 }, { from: '2027-01', value: 500_000 }] };
    expect(accrualsOf(e, '2026-10')).toEqual([]);
    expect(accrualsOf(e, '2027-01')).toEqual([{ month: '2026-11', amount: 400_000 }, { month: '2026-12', amount: 400_000 }, { month: '2027-01', amount: 500_000 }]);
    expect(accrualsOf({ ...e, end_month: '2026-12' }, '2027-03')).toHaveLength(2);
  });

  it('pay status: к выплате until the 14th of the next month, then просрочено', () => {
    expect(payStatus('2026-11', false, '2026-12-14')).toBe('due');
    expect(payStatus('2026-11', false, '2026-12-15')).toBe('overdue');
    expect(payStatus('2026-11', true, '2027-05-01')).toBe('paid');
  });

  it('reminders: the 12th–13th «before», the 14th–20th «due day», one key a month', () => {
    expect(reminderFor('2026-12-11')).toBeNull();
    expect(reminderFor('2026-12-12')).toEqual({ kind: 'before_due', key: '2026-12-12' });
    expect(reminderFor('2026-12-13')).toEqual({ kind: 'before_due', key: '2026-12-12' });
    expect(reminderFor('2026-12-14')).toEqual({ kind: 'due_day', key: '2026-12-14' });
    expect(reminderFor('2026-12-20')).toEqual({ kind: 'due_day', key: '2026-12-14' });
    expect(reminderFor('2026-12-21')).toBeNull();
  });
});

describe('finance-math: summary', () => {
  it('net profit = revenue − cost − commission − delivery − tax − other expenses − salaries; channels add up', () => {
    const events = [
      ev({ channel: 'yandex', lines: [line({ qty: 2, revenue: 400_000, cost: 60_000, commission: 40_000 })], own_delivery: 15_000 }),
      ev({ channel: 'vitalo', lines: [line({ product_id: 'p2' })], own_delivery: 20_000 }),
    ];
    const s = summarize(events, { from: '2026-11-01', to: '2026-11-30', taxRates: RATE, otherExpenses: 25_000, salaries: 100_000 });
    expect(s.channels.yandex).toMatchObject({ revenue: 400_000, cost: 60_000, commission: 40_000, delivery: 15_000, tax: 4_000, profit: 281_000 });
    expect(s.channels.vitalo).toMatchObject({ revenue: 100_000, cost: 30_000, commission: 0, delivery: 20_000, tax: 1_000, profit: 49_000 });
    expect(s.sales).toMatchObject({ revenue: 500_000, cost: 90_000, commission: 40_000, delivery: 35_000, tax: 5_000, profit: 330_000 });
    expect(s.net_profit).toBe(330_000 - 25_000 - 100_000);
    expect(s.incomplete).toBe(false);
    for (const k of Object.keys(s.sales) as (keyof typeof s.sales)[]) expect(s.channels.yandex[k] + s.channels.vitalo[k]).toBe(s.sales[k]);
  });

  it('unknown cost is never a silent zero: a separate sum and «неполная»', () => {
    const s = summarize([ev({ lines: [line({ cost: null, revenue: 50_000 }), line()] })], { from: '2026-11-01', to: '2026-11-30', taxRates: RATE, otherExpenses: 0, salaries: 0 });
    expect(s.sales).toMatchObject({ revenue: 150_000, cost: 30_000, revenue_without_cost: 50_000 });
    expect(s.incomplete).toBe(true);
    expect(s.products[0].incomplete).toBe(true);
  });

  it('a return takes the sale back in ITS month; the month of the sale is not rewritten; our delivery is not given back', () => {
    const sale = ev({ day: '2026-11-20', own_delivery: 20_000 });
    const back = ev({ day: '2026-12-03', sign: -1, own_delivery: 20_000 });
    const nov = summarize([sale, back], { from: '2026-11-01', to: '2026-11-30', taxRates: RATE, otherExpenses: 0, salaries: 0 });
    const dec = summarize([sale, back, ev({ day: '2026-12-05', lines: [line({ qty: 3, revenue: 300_000, cost: 90_000 })] })], { from: '2026-12-01', to: '2026-12-31', taxRates: RATE, otherExpenses: 0, salaries: 0 });
    expect(nov.sales).toMatchObject({ revenue: 100_000, tax: 1_000, delivery: 20_000 });
    expect(dec.sales).toMatchObject({ revenue: 200_000, cost: 60_000, tax: 2_000, delivery: 0, units: 2 });
    const t = turnoverByMonth([sale, back]);
    expect(t.get('2026-11')).toEqual({ yandex: 0, vitalo: 100_000 });
    expect(t.get('2026-12')).toEqual({ yandex: 0, vitalo: -100_000 });
    expect(monthTax(t.get('2026-12')!, 1)).toBe(0); // more returns than sales: nothing is due, never negative
  });

  it('tax: the rate of each month; rounding to whole сум', () => {
    expect(taxOf(123_456, 1)).toBe(1_235);
    const rates = [{ from: '2000-01', value: 1 }, { from: '2026-12', value: 2 }];
    const s = summarize([ev({ day: '2026-11-30' }), ev({ day: '2026-12-01' })], { from: '2026-11-01', to: '2026-12-31', taxRates: rates, otherExpenses: 0, salaries: 0 });
    expect(s.sales.tax).toBe(1_000 + 2_000);
  });

  it('channel filter: only that channel', () => {
    const s = summarize([ev({ channel: 'yandex' }), ev()], { from: '2026-11-01', to: '2026-11-30', taxRates: RATE, otherExpenses: 0, salaries: 0, channel: 'yandex' });
    expect(s.sales.revenue).toBe(100_000);
    expect(s.channels.vitalo.revenue).toBe(0);
  });
});
