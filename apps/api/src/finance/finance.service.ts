import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { tashkentDateString } from '../common/tashkent';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../staff/audit.service';
import {
  accrualsOf,
  addMonths,
  dueDay,
  firstDay,
  lastDay,
  MONTH_RE,
  monthOfDay,
  monthsBetween,
  monthTax,
  payStatus,
  salariesInPeriod,
  summarize,
  turnoverByMonth,
  valueFor,
  type Channel,
  type RateFrom,
  type SaleEvent,
  type SaleLine,
} from './finance-math';

/** Settings key: the turnover tax rate by month, [{ from: 'YYYY-MM', value: percent }]. Default 1 % from the start. */
export const TAX_RATES_KEY = 'tax_rates';
export const DEFAULT_TAX_RATES: RateFrom[] = [{ from: '2000-01', value: 1 }];
export const DEFAULT_EXPENSE_CATEGORIES = ['Упаковка', 'Реклама', 'Непредвиденные', 'Прочее'];

const day = (d: Date) => tashkentDateString(d);
const dateOnly = (d: Date) => d.toISOString().slice(0, 10); // @db.Date values
const asDate = (s: string) => new Date(`${s}T00:00:00Z`);

/**
 * Stage 3 (admin only): expenses, the turnover tax, payroll and analytics. Everything is counted here on the
 * server from «sale events» (finance-math.ts), so every screen shows the same numbers. Test orders are never read.
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  today(now = new Date()): string {
    return day(now);
  }

  // ---------------------------------------------------------------- sale events

  /**
   * Every recognised sale and return of both channels, test orders excluded.
   * Sale: the order became «Доставлен» (delivered_at). Return: a delivered order later became «Возврат».
   */
  async saleEvents(): Promise<SaleEvent[]> {
    const events: SaleEvent[] = [];

    const yandex = await this.prisma.marketplace_orders.findMany({
      where: { is_test: false, delivered_at: { not: null } },
      include: {
        lines: { include: { product: { select: { id: true, sku: true, name_ru: true } } } },
        units: { include: { unit: { select: { actual_cost_uzs: true } } } },
      },
    });
    for (const o of yandex) {
      const pct = Number(o.commission_percent);
      const lines: SaleLine[] = o.lines.map((l) => {
        // the units that really left with the order: not the ones swapped or released before the handover
        const units = o.units.filter((u) => u.line_id === l.id && (u.released_at === null || u.cost_snapshot_uzs !== null || u.return_decision !== null));
        const revenue = Number(l.unit_price_uzs) * l.qty;
        return {
          product_id: l.product.id,
          sku: l.product.sku,
          name: l.product.name_ru,
          qty: l.qty,
          revenue,
          cost: units.length === l.qty ? units.reduce((s, u) => s + Number(u.cost_snapshot_uzs ?? u.unit.actual_cost_uzs), 0) : null,
          commission: Math.round((revenue * pct) / 100),
        };
      });
      const base = { channel: 'yandex' as Channel, order_id: o.id, number: o.external_number, lines, own_delivery: Number(o.own_delivery_cost_uzs) };
      events.push({ ...base, day: day(o.delivered_at!), sign: 1 });
      if (o.status === 'RETURNED' && o.closed_at) events.push({ ...base, day: day(o.closed_at), sign: -1 });
    }

    const vitalo = await this.prisma.orders.findMany({
      where: { is_test: false, delivered_at: { not: null } },
      include: {
        items: { include: { product: { select: { id: true, sku: true, name_ru: true } }, units: { where: { cost_snapshot_uzs: { not: null } } } } },
        history: { where: { to_status: 'return' }, orderBy: { created_at: 'desc' }, take: 1 },
      },
    });
    for (const o of vitalo) {
      const lines: SaleLine[] = o.items.map((i) => ({
        product_id: i.product.id,
        sku: i.product.sku,
        name: i.product.name_ru,
        qty: i.qty,
        // the goods only: the delivery the customer pays is a transit, neither revenue nor expense (S3-2)
        revenue: Number(i.paid_line_total_uzs),
        cost: i.units.length === i.qty ? i.units.reduce((s, u) => s + Number(u.cost_snapshot_uzs), 0) : null,
        commission: 0,
      }));
      const base = { channel: 'vitalo' as Channel, order_id: o.id, number: o.order_number, lines, own_delivery: Number(o.own_delivery_cost_uzs) };
      events.push({ ...base, day: day(o.delivered_at!), sign: 1 });
      if (o.status === 'return' && o.history[0]) events.push({ ...base, day: day(o.history[0].created_at), sign: -1 });
    }
    return events;
  }

  // ---------------------------------------------------------------- tax

  async taxRates(): Promise<RateFrom[]> {
    const saved = await this.settings.get<RateFrom[]>(TAX_RATES_KEY);
    return Array.isArray(saved) && saved.length ? saved : DEFAULT_TAX_RATES;
  }

  /** A new rate from a month on. Past months are never recalculated: the month must not be earlier than the current one. */
  async setTaxRate(staffId: string, fromMonth: string, percent: number, today = this.today()) {
    if (fromMonth < monthOfDay(today)) {
      throw new BadRequestException({ code: 'PAST_MONTH', message: 'Ставку можно менять только с текущего или будущего месяца: прошлые месяцы не пересчитываются' });
    }
    const before = await this.taxRates();
    const after = [...before.filter((r) => r.from !== fromMonth), { from: fromMonth, value: percent }].sort((a, b) => a.from.localeCompare(b.from));
    await this.prisma.$transaction(async (tx) => {
      await tx.settings.upsert({ where: { key: TAX_RATES_KEY }, create: { key: TAX_RATES_KEY, value: after as unknown as Prisma.InputJsonValue }, update: { value: after as unknown as Prisma.InputJsonValue } });
      await this.audit.log({ staffId, action: 'finance.tax_rate_changed', entityType: 'settings', before: { rates: before }, after: { from_month: fromMonth, percent } }, tx);
    });
    return this.tax(today);
  }

  /**
   * «Налог»: every month from the first sale to the current one. Turnover = sold in the month − returned in the
   * month. A paid month keeps what was paid; when the turnover changed afterwards (a late return is counted in ITS
   * month, but a test flag can move a sale) the difference is shown, nothing is rewritten.
   */
  async tax(today = this.today()) {
    const [events, rates, payments] = await Promise.all([this.saleEvents(), this.taxRates(), this.prisma.tax_payments.findMany()]);
    const byMonth = turnoverByMonth(events);
    const current = monthOfDay(today);
    const first = [...byMonth.keys(), ...payments.map((p) => p.month), current].sort()[0];
    const months = monthsBetween(first, current)
      .reverse()
      .map((month) => {
        const t = byMonth.get(month) ?? { yandex: 0, vitalo: 0 };
        const percent = valueFor(rates, month) ?? 0;
        const taxNow = monthTax(t, percent);
        const paid = payments.find((p) => p.month === month);
        return {
          month,
          turnover_uzs: t.yandex + t.vitalo,
          turnover_yandex_uzs: t.yandex,
          turnover_vitalo_uzs: t.vitalo,
          rate_percent: percent,
          tax_uzs: taxNow,
          due_day: dueDay(month),
          closed: month < current, // the month is over: its tax is final and can be paid
          status: payStatus(month, !!paid, today),
          payment: paid
            ? { paid_on: dateOnly(paid.paid_on), paid_amount_uzs: Number(paid.paid_amount_uzs), tax_at_payment_uzs: Number(paid.tax_uzs), difference_uzs: taxNow - Number(paid.tax_uzs) }
            : null,
        };
      });
    return { rates, months };
  }

  async payTax(staffId: string, month: string, paidOn: string, amount: number, today = this.today()) {
    if (month >= monthOfDay(today)) throw new ConflictException({ code: 'MONTH_NOT_CLOSED', message: 'Месяц ещё не закончился: налог считается по итогу месяца' });
    const row = (await this.tax(today)).months.find((m) => m.month === month);
    if (!row) throw new NotFoundException({ code: 'MONTH_NOT_FOUND', message: 'Такого месяца нет в расчёте' });
    if (row.payment) throw new ConflictException({ code: 'ALREADY_PAID', message: 'Этот месяц уже отмечен оплаченным' });
    await this.prisma.$transaction(async (tx) => {
      await tx.tax_payments.create({ data: { month, paid_on: asDate(paidOn), paid_amount_uzs: BigInt(amount), turnover_uzs: BigInt(Math.max(0, row.turnover_uzs)), rate_percent: row.rate_percent, tax_uzs: BigInt(row.tax_uzs), paid_by: staffId } });
      await this.audit.log({ staffId, action: 'finance.tax_paid', entityType: 'tax', after: { month, paid_on: paidOn, paid_amount_uzs: amount, tax_uzs: row.tax_uzs, turnover_uzs: row.turnover_uzs } }, tx);
    });
    return this.tax(today);
  }

  // ---------------------------------------------------------------- payroll

  private async employees() {
    const rows = await this.prisma.payroll_employees.findMany({ orderBy: { created_at: 'asc' }, include: { rates: true, payments: true } });
    return rows.map((e) => ({ ...e, rateList: e.rates.map((r) => ({ from: r.from_month, value: Number(r.amount_uzs) })) }));
  }

  /** «Сотрудники и зарплаты»: accruals month by month from the start month to the current one. */
  async payroll(today = this.today()) {
    const current = monthOfDay(today);
    const employees = await this.employees();
    return {
      employees: employees.map((e) => {
        const months = accrualsOf({ start_month: e.start_month, end_month: e.end_month, rates: e.rateList }, current)
          .reverse()
          .map((a) => {
            const paid = e.payments.find((p) => p.month === a.month);
            return {
              month: a.month,
              amount_uzs: a.amount,
              due_day: dueDay(a.month),
              status: payStatus(a.month, !!paid, today),
              payment: paid ? { paid_on: dateOnly(paid.paid_on), amount_uzs: Number(paid.amount_uzs) } : null,
            };
          });
        return {
          id: e.id,
          name: e.name,
          start_month: e.start_month,
          end_month: e.end_month,
          active: !e.end_month || e.end_month >= current,
          amount_uzs: valueFor(e.rateList, current < e.start_month ? e.start_month : current) ?? 0,
          rates: e.rateList.sort((a, b) => a.from.localeCompare(b.from)).map((r) => ({ from_month: r.from, amount_uzs: r.value })),
          months,
        };
      }),
    };
  }

  async addEmployee(staffId: string, dto: { name: string; start_month: string; amount_uzs: number }, today = this.today()) {
    await this.prisma.$transaction(async (tx) => {
      const e = await tx.payroll_employees.create({ data: { name: dto.name, start_month: dto.start_month, rates: { create: { from_month: dto.start_month, amount_uzs: BigInt(dto.amount_uzs) } } } });
      await this.audit.log({ staffId, action: 'finance.employee_added', entityType: 'payroll_employee', entityId: e.id, after: dto }, tx);
    });
    return this.payroll(today);
  }

  /**
   * Name, on/off, and a new amount «с какого месяца». Past and already paid months are never recalculated: the
   * month of a new amount must not be earlier than the current one (or the start month when it is still ahead).
   */
  async updateEmployee(staffId: string, id: string, dto: { name?: string; active?: boolean; amount_uzs?: number; from_month?: string }, today = this.today()) {
    const current = monthOfDay(today);
    await this.prisma.$transaction(async (tx) => {
      const e = await tx.payroll_employees.findUnique({ where: { id }, include: { payments: true } });
      if (!e) throw new NotFoundException({ code: 'EMPLOYEE_NOT_FOUND', message: 'Сотрудник не найден' });
      const data: Prisma.payroll_employeesUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.active === false) {
        // the current month is still accrued (unless the employee has not started yet)
        if (e.start_month > current) throw new ConflictException({ code: 'NOT_STARTED', message: 'Сотрудник ещё не начал: измените месяц начала, добавив его заново' });
        data.end_month = current;
      }
      if (dto.active === true) data.end_month = null;
      if (dto.amount_uzs !== undefined) {
        const from = dto.from_month ?? current;
        const earliest = e.start_month > current ? e.start_month : current;
        if (from < earliest) throw new BadRequestException({ code: 'PAST_MONTH', message: 'Сумму можно менять только с текущего или будущего месяца: прошлые месяцы не пересчитываются' });
        if (e.payments.some((p) => p.month >= from)) throw new ConflictException({ code: 'MONTH_PAID', message: 'За этот месяц зарплата уже отмечена выплаченной' });
        await tx.payroll_rates.upsert({
          where: { employee_id_from_month: { employee_id: id, from_month: from } },
          create: { employee_id: id, from_month: from, amount_uzs: BigInt(dto.amount_uzs) },
          update: { amount_uzs: BigInt(dto.amount_uzs) },
        });
      }
      if (Object.keys(data).length) await tx.payroll_employees.update({ where: { id }, data });
      await this.audit.log({ staffId, action: 'finance.employee_changed', entityType: 'payroll_employee', entityId: id, before: { name: e.name, end_month: e.end_month }, after: dto }, tx);
    });
    return this.payroll(today);
  }

  async paySalary(staffId: string, id: string, dto: { month: string; paid_on: string; amount_uzs: number }, today = this.today()) {
    const e = (await this.payroll(today)).employees.find((x) => x.id === id);
    if (!e) throw new NotFoundException({ code: 'EMPLOYEE_NOT_FOUND', message: 'Сотрудник не найден' });
    const m = e.months.find((x) => x.month === dto.month);
    if (!m) throw new ConflictException({ code: 'NO_ACCRUAL', message: 'За этот месяц зарплата не начислена' });
    if (m.payment) throw new ConflictException({ code: 'ALREADY_PAID', message: 'Эта зарплата уже отмечена выплаченной' });
    await this.prisma.$transaction(async (tx) => {
      await tx.payroll_payments.create({ data: { employee_id: id, month: dto.month, paid_on: asDate(dto.paid_on), amount_uzs: BigInt(dto.amount_uzs), paid_by: staffId } });
      await this.audit.log({ staffId, action: 'finance.salary_paid', entityType: 'payroll_employee', entityId: id, after: { name: e.name, ...dto, accrued_uzs: m.amount_uzs } }, tx);
    });
    return this.payroll(today);
  }

  /** Every accrual of every employee up to the month (for the analytics and the reminders). */
  async accruals(untilMonth: string) {
    const out: { employee_id: string; name: string; month: string; amount: number; paid: boolean }[] = [];
    for (const e of await this.employees()) {
      for (const a of accrualsOf({ start_month: e.start_month, end_month: e.end_month, rates: e.rateList }, untilMonth)) {
        out.push({ employee_id: e.id, name: e.name, month: a.month, amount: a.amount, paid: e.payments.some((p) => p.month === a.month) });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- expenses

  async categories() {
    if (!(await this.prisma.expense_categories.count())) {
      await this.prisma.expense_categories.createMany({ data: DEFAULT_EXPENSE_CATEGORIES.map((name, i) => ({ name, position: i })), skipDuplicates: true });
    }
    const rows = await this.prisma.expense_categories.findMany({ orderBy: [{ position: 'asc' }, { name: 'asc' }], include: { _count: { select: { expenses: true } } } });
    return rows.map((c) => ({ id: c.id, name: c.name, hidden: c.hidden, expenses: c._count.expenses }));
  }

  async addCategory(staffId: string, name: string) {
    await this.categories();
    if (await this.prisma.expense_categories.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } })) {
      throw new ConflictException({ code: 'CATEGORY_EXISTS', message: 'Такая категория уже есть' });
    }
    const max = await this.prisma.expense_categories.aggregate({ _max: { position: true } });
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.expense_categories.create({ data: { name, position: (max._max.position ?? 0) + 1 } });
      await this.audit.log({ staffId, action: 'finance.category_added', entityType: 'expense_category', entityId: c.id, after: { name } }, tx);
    });
    return this.categories();
  }

  async updateCategory(staffId: string, id: string, dto: { name?: string; hidden?: boolean }) {
    const c = await this.prisma.expense_categories.findUnique({ where: { id } });
    if (!c) throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: 'Категория не найдена' });
    if (dto.name && (await this.prisma.expense_categories.findFirst({ where: { id: { not: id }, name: { equals: dto.name, mode: 'insensitive' } } }))) {
      throw new ConflictException({ code: 'CATEGORY_EXISTS', message: 'Такая категория уже есть' });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.expense_categories.update({ where: { id }, data: { ...(dto.name !== undefined && { name: dto.name }), ...(dto.hidden !== undefined && { hidden: dto.hidden }) } });
      await this.audit.log({ staffId, action: 'finance.category_changed', entityType: 'expense_category', entityId: id, before: { name: c.name, hidden: c.hidden }, after: dto }, tx);
    });
    return this.categories();
  }

  /** A category with expenses is never deleted (hide it instead); an empty one may go. */
  async deleteCategory(staffId: string, id: string) {
    const c = await this.prisma.expense_categories.findUnique({ where: { id }, include: { _count: { select: { expenses: true } } } });
    if (!c) throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: 'Категория не найдена' });
    if (c._count.expenses) throw new ConflictException({ code: 'CATEGORY_IN_USE', message: 'В категории есть расходы: её можно только скрыть' });
    await this.prisma.$transaction(async (tx) => {
      await tx.expense_categories.delete({ where: { id } });
      await this.audit.log({ staffId, action: 'finance.category_deleted', entityType: 'expense_category', entityId: id, before: { name: c.name } }, tx);
    });
    return this.categories();
  }

  async expenses(q: { from?: string; to?: string; category_id?: string }) {
    const where: Prisma.expensesWhereInput = {
      deleted_at: null,
      ...(q.category_id && { category_id: q.category_id }),
      ...((q.from || q.to) && { spent_on: { ...(q.from && { gte: asDate(q.from) }), ...(q.to && { lte: asDate(q.to) }) } }),
    };
    const rows = await this.prisma.expenses.findMany({ where, orderBy: [{ spent_on: 'desc' }, { created_at: 'desc' }], include: { category: { select: { name: true } } }, take: 1000 });
    const items = rows.map((e) => ({ id: e.id, spent_on: dateOnly(e.spent_on), category_id: e.category_id, category: e.category.name, amount_uzs: Number(e.amount_uzs), comment: e.comment }));
    const byCategory = new Map<string, number>();
    for (const i of items) byCategory.set(i.category, (byCategory.get(i.category) ?? 0) + i.amount_uzs);
    return { items, total_uzs: items.reduce((s, i) => s + i.amount_uzs, 0), by_category: [...byCategory.entries()].map(([category, amount_uzs]) => ({ category, amount_uzs })) };
  }

  async addExpense(staffId: string, dto: { spent_on: string; category_id: string; amount_uzs: number; comment?: string | null }) {
    const c = await this.prisma.expense_categories.findUnique({ where: { id: dto.category_id } });
    if (!c) throw new BadRequestException({ code: 'CATEGORY_NOT_FOUND', message: 'Категория не найдена' });
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.expenses.create({ data: { spent_on: asDate(dto.spent_on), category_id: dto.category_id, amount_uzs: BigInt(dto.amount_uzs), comment: dto.comment ?? null, created_by: staffId } });
      await this.audit.log({ staffId, action: 'finance.expense_added', entityType: 'expense', entityId: e.id, after: { ...dto, category: c.name } }, tx);
      return { id: e.id };
    });
  }

  async updateExpense(staffId: string, id: string, dto: { spent_on?: string; category_id?: string; amount_uzs?: number; comment?: string | null }) {
    await this.prisma.$transaction(async (tx) => {
      const e = await tx.expenses.findFirst({ where: { id, deleted_at: null } });
      if (!e) throw new NotFoundException({ code: 'EXPENSE_NOT_FOUND', message: 'Расход не найден' });
      if (dto.category_id && !(await tx.expense_categories.findUnique({ where: { id: dto.category_id } }))) throw new BadRequestException({ code: 'CATEGORY_NOT_FOUND', message: 'Категория не найдена' });
      await tx.expenses.update({
        where: { id },
        data: {
          ...(dto.spent_on !== undefined && { spent_on: asDate(dto.spent_on) }),
          ...(dto.category_id !== undefined && { category_id: dto.category_id }),
          ...(dto.amount_uzs !== undefined && { amount_uzs: BigInt(dto.amount_uzs) }),
          ...(dto.comment !== undefined && { comment: dto.comment }),
        },
      });
      await this.audit.log(
        { staffId, action: 'finance.expense_changed', entityType: 'expense', entityId: id, before: { spent_on: dateOnly(e.spent_on), category_id: e.category_id, amount_uzs: Number(e.amount_uzs), comment: e.comment }, after: dto },
        tx,
      );
    });
    return { id };
  }

  /** Deleted with a reason; the row stays in the database (and in the audit log), it only leaves the lists and sums. */
  async deleteExpense(staffId: string, id: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const e = await tx.expenses.findFirst({ where: { id, deleted_at: null } });
      if (!e) throw new NotFoundException({ code: 'EXPENSE_NOT_FOUND', message: 'Расход не найден' });
      await tx.expenses.update({ where: { id }, data: { deleted_at: new Date(), delete_reason: reason } });
      await this.audit.log({ staffId, action: 'finance.expense_deleted', entityType: 'expense', entityId: id, before: { spent_on: dateOnly(e.spent_on), amount_uzs: Number(e.amount_uzs), comment: e.comment }, after: { reason } }, tx);
    });
    return { id, deleted: true };
  }

  // ---------------------------------------------------------------- analytics

  /**
   * «Аналитика»: the period [from, to] (days) and the channel. Sales figures are per channel; other expenses and
   * salaries are not split by channel — with a channel chosen they are not counted (profit of the channel before the
   * shared expenses), with «все» they are subtracted once.
   */
  async analytics(q: { from: string; to: string; channel?: Channel | null }, today = this.today()) {
    if (q.from > q.to) throw new BadRequestException({ code: 'BAD_PERIOD', message: 'Начало периода позже конца' });
    const [events, rates] = await Promise.all([this.saleEvents(), this.taxRates()]);
    const expenses = await this.prisma.expenses.aggregate({ where: { deleted_at: null, spent_on: { gte: asDate(q.from), lte: asDate(q.to) } }, _sum: { amount_uzs: true } });
    const lastMonth = monthOfDay(q.to) < monthOfDay(today) ? monthOfDay(q.to) : monthOfDay(today);
    const salaries = salariesInPeriod(await this.accruals(lastMonth), q.from, q.to);
    const shared = !q.channel;
    const summary = summarize(events, { from: q.from, to: q.to, taxRates: rates, channel: q.channel ?? null, otherExpenses: shared ? Number(expenses._sum.amount_uzs ?? 0n) : 0, salaries: shared ? salaries : 0 });

    // «вложено в закупки» — for reference only: the cost is already counted through the units sold
    // аудит 10.11, п. 1.5: тестовые закупки не входят
    const purchases = await this.prisma.purchases.findMany({ where: { is_test: false, purchase_date: { gte: asDate(q.from), lte: asDate(q.to) } }, include: { lines: true } });
    const invested = purchases.reduce((s, p) => s + (p.final_actual_total_uzs !== null ? Number(p.final_actual_total_uzs) : p.lines.reduce((x, l) => x + (l.ordered_qty - l.cancelled_qty) * Number(l.unit_price_original_uzs), 0)), 0);

    return {
      period: { from: q.from, to: q.to, channel: q.channel ?? 'all' },
      ...summary,
      shared_expenses_included: shared,
      purchases_invested_uzs: invested,
      top_products: summary.products.slice(0, 5).map((p) => ({ sku: p.sku, name: p.name, qty: p.qty, revenue: p.revenue })),
      attention: await this.attention(events, today),
    };
  }

  /** What needs a look: jars expiring within 90 days, products with stock and no sales for 60 days, orders waiting for jars. */
  private async attention(events: SaleEvent[], today: string) {
    const in90 = new Date(asDate(today).getTime() + 90 * 86_400_000);
    const expiring = await this.prisma.physical_units.findMany({
      where: { status: { in: ['IN_STOCK', 'ASSIGNED'] }, expiry_date: { lt: in90 }, product: { is_test: false } },
      orderBy: [{ expiry_date: 'asc' }, { seq: 'asc' }],
      take: 100,
      select: { id: true, physical_id: true, expiry_date: true, status: true, product: { select: { sku: true, name_ru: true } } },
    });
    const since = dateOnly(new Date(asDate(today).getTime() - 60 * 86_400_000));
    const soldRecently = new Set(events.filter((e) => e.sign === 1 && e.day >= since).flatMap((e) => e.lines.map((l) => l.product_id)));
    // аудит 4.9: the money frozen on the shelf — the actual cost of the jars
    const onShelf = await this.prisma.physical_units.groupBy({ by: ['product_id'], where: { status: 'IN_STOCK' }, _count: { _all: true }, _sum: { actual_cost_uzs: true } });
    const staleIds = onShelf.filter((r) => !soldRecently.has(r.product_id));
    const staleProducts = await this.prisma.products.findMany({ where: { id: { in: staleIds.map((r) => r.product_id) }, status: { not: 'archived' }, is_test: false }, select: { id: true, sku: true, name_ru: true } });
    const waiting = await this.prisma.orders.findMany({ where: { units_attention: { not: null }, status: { in: ['paid', 'picking'] } }, select: { id: true, order_number: true, units_attention: true }, orderBy: { paid_at: 'asc' } });
    return {
      expiring: expiring.map((u) => ({ id: u.id, physical_id: u.physical_id, sku: u.product.sku, name: u.product.name_ru, expiry_date: dateOnly(u.expiry_date), expired: dateOnly(u.expiry_date) < today })),
      stale: staleProducts
        .map((p) => {
          const g = staleIds.find((r) => r.product_id === p.id)!;
          return { product_id: p.id, sku: p.sku, name: p.name_ru, on_shelf: g._count._all, cost_uzs: Number(g._sum.actual_cost_uzs ?? 0) };
        })
        .sort((a, b) => b.cost_uzs - a.cost_uzs || b.on_shelf - a.on_shelf),
      orders_waiting_units: waiting.map((o) => ({ id: o.id, order_number: o.order_number, reason: o.units_attention })),
    };
  }

  // ---------------------------------------------------------------- reminders

  /** What is not marked paid for the months up to `month` (inclusive): the tax and the salaries. */
  async unpaidFor(month: string, today = this.today()) {
    const taxDue = (await this.tax(today)).months.filter((m) => m.month <= month && !m.payment).reduce((s, m) => s + m.tax_uzs, 0);
    const salaries = (await this.accruals(month)).filter((a) => !a.paid).reduce((s, a) => s + a.amount, 0);
    return { tax_uzs: taxDue, salaries_uzs: salaries };
  }

  static monthBefore(today: string) {
    return addMonths(monthOfDay(today), -1);
  }

  static periodOfMonth(month: string) {
    if (!MONTH_RE.test(month)) throw new BadRequestException({ code: 'BAD_MONTH', message: 'Месяц пишется как ГГГГ-ММ' });
    return { from: firstDay(month), to: lastDay(month) };
  }
}
