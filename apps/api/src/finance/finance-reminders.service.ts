import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { tashkentDateString } from '../common/tashkent';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceService } from './finance.service';

export type ReminderKind = 'before_due' | 'due_day';

/**
 * Which reminder belongs to the day (Tashkent): the 12th–13th — «14-го к оплате», the 14th–20th — «срок сегодня /
 * прошёл, не отмечено оплаченным». The window is wider than one day because the computer may be off on the very
 * day; the key is always the 12th or the 14th, so each reminder goes out once a month.
 */
export function reminderFor(today: string): { kind: ReminderKind; key: string } | null {
  const d = Number(today.slice(8, 10));
  const month = today.slice(0, 7);
  if (d === 12 || d === 13) return { kind: 'before_due', key: `${month}-12` };
  if (d >= 14 && d <= 20) return { kind: 'due_day', key: `${month}-14` };
  return null;
}

/**
 * Stage 3: Telegram reminders to admins about the tax and the salaries due on the 14th. The fact of sending is a
 * row in finance_reminders (unique kind + day) written in the same transaction as the messages: a restart or a
 * second API instance never sends it twice.
 */
@Injectable()
export class FinanceRemindersService {
  private readonly logger = new Logger(FinanceRemindersService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
    private readonly notifications: NotificationsService,
  ) {}

  @Interval('finance-reminders', 10 * 60_000)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const sent = await this.runOnce();
      if (sent) this.logger.log(`Finance reminder (${sent}) queued`);
    } catch (e) {
      this.logger.error('Finance reminders failed', e as Error);
    } finally {
      this.running = false;
    }
  }

  /** Returns the kind that was queued now, or null (not the day, already sent, or nothing to pay). */
  async runOnce(now = new Date()): Promise<ReminderKind | null> {
    const today = tashkentDateString(now);
    const r = reminderFor(today);
    if (!r) return null;
    const day = new Date(`${r.key}T00:00:00Z`);
    if (await this.prisma.finance_reminders.findUnique({ where: { kind_day: { kind: r.kind, day } } })) return null;
    const due = await this.finance.unpaidFor(FinanceService.monthBefore(today), today);
    if (due.tax_uzs + due.salaries_uzs <= 0) return null; // everything is paid: nothing to remind about
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.finance_reminders.create({ data: { kind: r.kind, day } });
        await this.notifications.toStaffRoles(tx, ['admin'], r.kind === 'before_due' ? 'staff.finance_before_due' : 'staff.finance_due_day', {
          order_number: '',
          tax_uzs: due.tax_uzs,
          salaries_uzs: due.salaries_uzs,
          admin_path: '/finance',
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null; // another instance was first
      throw e;
    }
    return r.kind;
  }
}
