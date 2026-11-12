import { Controller, Get, Global, Injectable, Logger, Module, Query, UseGuards } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';
import { AuthModule } from '../auth/auth.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { BonusOp, OrderStatus, Prisma } from '@prisma/client';
import { isTashkentWorkingHours, tashkentDateString } from '../common/tashkent';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { BonusSettings, cashbackOf, normalizeBonusSettings } from './bonus-rules';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

const DAY_MS = 86_400_000;

export interface BonusPost {
  userId: string;
  op: BonusOp;
  /** Signed: + accrual, − spending. A minus larger than the balance takes only what is left. */
  amount: number;
  /** Unique key of the operation: a second post with it does nothing (replays, double clicks). */
  ref: string;
  orderId?: string | null;
  reason?: string | null;
  staffId?: string | null;
  /** An accrual that restarts the lifetime (purchase, review, manual +). */
  activity?: boolean;
}

export interface BonusAccountView {
  balance_uzs: number;
  /** The whole balance burns on this day (Tashkent, YYYY-MM-DD); null — nothing to burn. */
  expires_on: string | null;
  last_activity_at: string | null;
}

/** «12.02.2027» from "2027-02-12". */
export function dmyOf(date: string): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
}

/**
 * 3.10-А (D-71): VITALO Bonus. Every change of a balance is one immutable row of `bonus_ledger` with a unique key, and
 * the account row is locked first (SELECT … FOR UPDATE): an order, a status change and the expiry job may meet.
 */
@Injectable()
export class BonusService {
  private readonly logger = new Logger(BonusService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  async settings(): Promise<BonusSettings> {
    return normalizeBonusSettings(await this.settingsService.get<Partial<BonusSettings>>('bonus'));
  }

  /** The balance (locked with `lock`, inside a transaction). No account yet — 0. */
  async balance(db: Db, userId: string, opts: { lock?: boolean } = {}): Promise<number> {
    if (opts.lock) {
      const [row] = await db.$queryRaw<{ balance_uzs: bigint }[]>`SELECT balance_uzs FROM bonus_accounts WHERE user_id = ${userId}::uuid FOR UPDATE`;
      return Number(row?.balance_uzs ?? 0n);
    }
    const row = await db.bonus_accounts.findUnique({ where: { user_id: userId }, select: { balance_uzs: true } });
    return Number(row?.balance_uzs ?? 0n);
  }

  async account(userId: string, db: Db = this.prisma): Promise<BonusAccountView> {
    const row = await db.bonus_accounts.findUnique({ where: { user_id: userId } });
    const balance = Number(row?.balance_uzs ?? 0n);
    const s = await this.settings();
    return {
      balance_uzs: balance,
      expires_on: balance > 0 && row?.last_activity_at ? tashkentDateString(new Date(row.last_activity_at.getTime() + s.lifetime_days * DAY_MS)) : null,
      last_activity_at: row?.last_activity_at?.toISOString() ?? null,
    };
  }

  /** The history of a customer, newest first. */
  async history(userId: string, opts: { limit?: number; before?: Date } = {}) {
    const rows = await this.prisma.bonus_ledger.findMany({
      where: { account: { user_id: userId }, ...(opts.before && { created_at: { lt: opts.before } }) },
      orderBy: { created_at: 'desc' },
      take: Math.min(opts.limit ?? 30, 100),
      include: { order: { select: { order_number: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      op: r.operation_type,
      amount_uzs: Number(r.amount_uzs),
      balance_after_uzs: Number(r.balance_after_uzs),
      order_id: r.order_id,
      order_number: r.order?.order_number ?? null,
      created_at: r.created_at.toISOString(),
    }));
  }

  /** One operation. Returns the amount really posted, or null when the key was already used (or nothing to post). */
  async post(tx: Tx, p: BonusPost): Promise<{ amount_uzs: number; balance_uzs: number } | null> {
    if (!Number.isInteger(p.amount) || p.amount === 0) return null;
    await tx.$executeRaw`INSERT INTO bonus_accounts (id, user_id, balance_uzs, updated_at) VALUES (gen_random_uuid(), ${p.userId}::uuid, 0, now()) ON CONFLICT (user_id) DO NOTHING`;
    const [acc] = await tx.$queryRaw<{ id: string; balance_uzs: bigint }[]>`SELECT id, balance_uzs FROM bonus_accounts WHERE user_id = ${p.userId}::uuid FOR UPDATE`;
    if (await tx.bonus_ledger.findUnique({ where: { idempotency_ref: p.ref }, select: { id: true } })) return null;
    const before = Number(acc.balance_uzs);
    const amount = p.amount < 0 ? -Math.min(before, -p.amount) : p.amount;
    if (amount === 0) return null;
    const after = before + amount;
    const now = new Date();
    await tx.bonus_ledger.create({
      data: {
        bonus_account_id: acc.id,
        operation_type: p.op,
        amount_uzs: BigInt(amount),
        balance_after_uzs: BigInt(after),
        order_id: p.orderId ?? null,
        idempotency_ref: p.ref,
        reason: p.reason ?? null,
        created_by: p.staffId ?? null,
        created_at: now,
      },
    });
    await tx.bonus_accounts.update({
      where: { id: acc.id },
      data: { balance_uzs: BigInt(after), ...(p.activity && amount > 0 && { last_activity_at: now }) },
    });
    return { amount_uzs: amount, balance_uzs: after };
  }

  /** Bonuses spent on a new order (inside the order transaction, after the order row). */
  async redeem(tx: Tx, userId: string, orderId: string, amount: number, orderNumber: string) {
    if (amount <= 0) return;
    const r = await this.post(tx, { userId, op: 'redemption', amount: -amount, ref: `redeem:${orderId}`, orderId, reason: `Оплата заказа ${orderNumber}` });
    // the calculation locked the account and checked the balance: anything else is a bug, never a silent discount
    if (!r || r.amount_uzs !== -amount) throw new Error(`Bonus redemption of order ${orderNumber} failed`);
  }

  /**
   * Called on every status change (OrderLifecycleService.addHistory):
   * - delivered and paid → cashback at the rate frozen in the order (bonus_rate_snapshot);
   * - cancelled → the spent bonuses come back;
   * - return → the cashback is taken back (what is left of it) and the spent bonuses come back.
   */
  async onOrderStatus(tx: Tx, orderId: string, to: OrderStatus) {
    if (to !== 'delivered' && to !== 'cancelled' && to !== 'return') return;
    const order = await tx.orders.findUnique({
      where: { id: orderId },
      select: { id: true, user_id: true, order_number: true, payment_status: true, goods_paid_uzs: true, bonus_used_uzs: true, bonus_rate_snapshot: true, user: { select: { telegram_user_id: true, language: true } } },
    });
    if (!order) return;
    const lang = order.user.language === 'uz' ? 'uz' : 'ru';
    const notify = async (template: 'bonus.accrued' | 'bonus.returned', amount: number, balance: number) =>
      this.notifications.toCustomer(tx, {
        userId: order.user_id,
        chatId: order.user.telegram_user_id,
        template,
        category: 'bonus',
        payload: { order_number: order.order_number, lang, bonus_uzs: amount, balance_uzs: balance, open_path: '/bonus', open_button: 'bonus' },
        dedupKey: `${template}:${order.id}`,
      });

    if (to === 'delivered') {
      if (order.payment_status !== 'payment_success') return;
      const pct = order.bonus_rate_snapshot == null ? 0 : Number(order.bonus_rate_snapshot) * 100;
      const amount = cashbackOf(Number(order.goods_paid_uzs), pct);
      const r = await this.post(tx, { userId: order.user_id, op: 'purchase', amount, ref: `purchase:${order.id}`, orderId: order.id, reason: `Кешбэк ${pct}% за заказ ${order.order_number}`, activity: true });
      if (r) await notify('bonus.accrued', r.amount_uzs, r.balance_uzs);
      return;
    }

    if (to === 'return') {
      const accrued = await tx.bonus_ledger.findUnique({ where: { idempotency_ref: `purchase:${order.id}` }, select: { amount_uzs: true } });
      if (accrued) {
        await this.post(tx, { userId: order.user_id, op: 'reversal', amount: -Number(accrued.amount_uzs), ref: `unpurchase:${order.id}`, orderId: order.id, reason: `Возврат заказа ${order.order_number}: кешбэк отменён` });
      }
    }
    const spent = Number(order.bonus_used_uzs);
    if (spent > 0 && (await tx.bonus_ledger.findUnique({ where: { idempotency_ref: `redeem:${order.id}` }, select: { id: true } }))) {
      const why = to === 'return' ? 'Возврат' : 'Отмена';
      const r = await this.post(tx, { userId: order.user_id, op: 'reversal', amount: spent, ref: `refund:${order.id}`, orderId: order.id, reason: `${why} заказа ${order.order_number}: бонусы возвращены` });
      if (r) await notify('bonus.returned', r.amount_uzs, r.balance_uzs);
    }
  }

  /** Admin «+ Начислить» / «− Списать» on the customer card (the reason is required; the audit is written by the caller). */
  async manual(tx: Tx, userId: string, amount: number, reason: string, staffId: string, ref: string) {
    const r = await this.post(tx, { userId, op: amount > 0 ? 'manual_add' : 'manual_subtract', amount, ref, reason, staffId, activity: amount > 0 });
    if (r && r.amount_uzs > 0) {
      const user = await tx.users.findUniqueOrThrow({ where: { id: userId }, select: { telegram_user_id: true, language: true } });
      await this.notifications.toCustomer(tx, {
        userId,
        chatId: user.telegram_user_id,
        template: 'bonus.accrued',
        category: 'bonus',
        payload: { order_number: '', lang: user.language === 'uz' ? 'uz' : 'ru', bonus_uzs: r.amount_uzs, balance_uzs: r.balance_uzs, open_path: '/bonus', open_button: 'bonus' },
        dedupKey: `bonus.accrued:${ref}`,
      });
    }
    return r;
  }

  @Interval('bonus-expiry', 60 * 60_000)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.runExpiry();
      if (r.expired || r.reminded) this.logger.log(`Bonus: ${r.expired} balances burnt, ${r.reminded} reminders queued`);
    } catch (e) {
      this.logger.error('Bonus expiry failed', e as Error);
    } finally {
      this.running = false;
    }
  }

  /**
   * Burns the balances whose lifetime is over; remind_days before, once per last accrual, the customer gets
   * «Через 7 дней сгорят N сум» (in the daytime only).
   */
  async runExpiry(now = new Date()): Promise<{ expired: number; reminded: number }> {
    const s = await this.settings();
    const burnBefore = new Date(now.getTime() - s.lifetime_days * DAY_MS);
    let expired = 0;
    const due = await this.prisma.bonus_accounts.findMany({ where: { balance_uzs: { gt: 0 }, last_activity_at: { lte: burnBefore } }, select: { id: true, user_id: true, last_activity_at: true }, take: 500 });
    for (const a of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        // the account row is locked by post(); a purchase in between moves last_activity_at, so check again
        const [fresh] = await tx.$queryRaw<{ last_activity_at: Date | null }[]>`SELECT last_activity_at FROM bonus_accounts WHERE id = ${a.id}::uuid FOR UPDATE`;
        if (!fresh?.last_activity_at || fresh.last_activity_at > burnBefore) return null;
        const balance = await this.balance(tx, a.user_id);
        return this.post(tx, { userId: a.user_id, op: 'expire', amount: -balance, ref: `expire:${a.id}:${fresh.last_activity_at.getTime()}`, reason: `Срок ${s.lifetime_days} дней после последнего начисления` });
      });
      if (done) expired++;
    }

    let reminded = 0;
    if (!isTashkentWorkingHours(now)) return { expired, reminded };
    const remindBefore = new Date(now.getTime() - (s.lifetime_days - s.remind_days) * DAY_MS);
    const soon = await this.prisma.bonus_accounts.findMany({
      where: { balance_uzs: { gt: 0 }, last_activity_at: { lte: remindBefore, gt: burnBefore } },
      include: { user: { select: { telegram_user_id: true, language: true } } },
      take: 500,
    });
    for (const a of soon) {
      if (!a.last_activity_at || (a.expiry_notified_for && a.expiry_notified_for.getTime() === a.last_activity_at.getTime())) continue;
      const on = tashkentDateString(new Date(a.last_activity_at.getTime() + s.lifetime_days * DAY_MS));
      await this.prisma.$transaction(async (tx) => {
        await this.notifications.toCustomer(tx, {
          userId: a.user_id,
          chatId: a.user.telegram_user_id,
          template: 'bonus.expiring',
          category: 'bonus',
          payload: { order_number: '', lang: a.user.language === 'uz' ? 'uz' : 'ru', bonus_uzs: Number(a.balance_uzs), burn_date: dmyOf(on), open_path: '/catalog', open_button: 'link' },
          dedupKey: `bonus.expiring:${a.id}:${a.last_activity_at!.getTime()}`,
        });
        await tx.bonus_accounts.update({ where: { id: a.id }, data: { expiry_notified_for: a.last_activity_at } });
      });
      reminded++;
    }
    return { expired, reminded };
  }

  /** Admin dashboard: accrued / spent / burnt in a month (Tashkent, "YYYY-MM") and the balance owed to customers now. */
  async monthStats(month: string) {
    const from = new Date(`${month}-01T00:00:00+05:00`);
    const to = new Date(from);
    to.setUTCMonth(to.getUTCMonth() + 1);
    const where = { created_at: { gte: from, lt: to } };
    const [plus, minus] = await Promise.all([
      this.prisma.bonus_ledger.groupBy({ by: ['operation_type'], where: { ...where, amount_uzs: { gt: 0 } }, _sum: { amount_uzs: true } }),
      this.prisma.bonus_ledger.groupBy({ by: ['operation_type'], where: { ...where, amount_uzs: { lt: 0 } }, _sum: { amount_uzs: true } }),
    ]);
    const sum = (rows: typeof plus, ops: BonusOp[]) => Math.abs(rows.filter((r) => ops.includes(r.operation_type)).reduce((t, r) => t + Number(r._sum.amount_uzs ?? 0n), 0));
    const owed = await this.prisma.bonus_accounts.aggregate({ _sum: { balance_uzs: true }, _count: { _all: true }, where: { balance_uzs: { gt: 0 } } });
    return {
      month,
      /** cashback, reviews, admin «+» */
      accrued_uzs: sum(plus, ['purchase', 'review', 'manual_add', 'promo', 'referral']),
      /** paid for orders (a discount: it lowers the revenue of the order) */
      spent_uzs: sum(minus, ['redemption']),
      /** spent bonuses given back after a cancellation or a return */
      refunded_uzs: sum(plus, ['reversal']),
      /** cashback taken back after a return, and admin «−» */
      taken_uzs: sum(minus, ['reversal', 'manual_subtract']),
      expired_uzs: sum(minus, ['expire']),
      owed_uzs: Number(owed._sum.balance_uzs ?? 0n),
      customers_with_balance: owed._count._all,
    };
  }
}

export class BonusHistoryQuery {
  @ApiPropertyOptional({ description: 'Следующая страница: created_at последней строки' }) @IsOptional() @IsISO8601() before?: string;
}

/** 3.10-А: «VITALO Bonus» in the profile — the balance, when it burns, the rules and the history. */
@ApiTags('bonus')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('bonus')
export class BonusController {
  constructor(private readonly bonus: BonusService) {}

  @Get()
  async mine(@CurrentAuth() auth: AuthContext, @Query() q: BonusHistoryQuery) {
    const s = await this.bonus.settings();
    return {
      ...(await this.bonus.account(auth.user.id)),
      rules: { enabled: s.enabled, cashback_pct: s.cashback_pct, max_spend_pct: s.max_spend_pct, lifetime_days: s.lifetime_days, review_uzs: s.review_uzs, review_photo_uzs: s.review_photo_uzs },
      history: await this.bonus.history(auth.user.id, { limit: 30, before: q.before ? new Date(q.before) : undefined }),
    };
  }
}

@Global()
@Module({ imports: [AuthModule], controllers: [BonusController], providers: [BonusService], exports: [BonusService] })
export class BonusModule {}
