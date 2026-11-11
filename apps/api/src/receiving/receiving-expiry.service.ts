import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { SystemErrorsService } from '../notifications/system-errors';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../staff/audit.service';

const DAY_MS = 86_400_000;

/**
 * Аудит админки 10.11, п. 1.14 (решение владельца 11.11): приёмки, которые висят открытыми.
 * - Приёмка по закупке, начатая больше суток назад, в которой не принято ни одной банки, отменяется сама; создателю —
 *   сообщение в бот. Отменять нечего: банок нет, остатки и себестоимость не меняются.
 * - Приёмка, в которой банки уже есть, не трогается: создателю раз в сутки напоминание завершить или отменить.
 * - Начальный остаток (OPENING_BALANCE) не трогается: его завершает или отменяет только администратор.
 * Каждая приёмка перепроверяется под блокировкой строки — можно запускать на нескольких копиях API.
 */
@Injectable()
export class ReceivingExpiryService {
  private readonly logger = new Logger(ReceivingExpiryService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly errors: SystemErrorsService,
  ) {}

  @Interval('receiving-expiry', 60 * 60_000)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const { cancelled, reminded } = await this.runOnce();
      if (cancelled || reminded) this.logger.log(`Receiving: ${cancelled} empty session(s) cancelled, ${reminded} reminder(s)`);
    } catch (e) {
      this.logger.error('Receiving expiry failed', e as Error);
      await this.errors.record({ level: 'error', service: 'receiving', message: `Receiving expiry job failed: ${(e as Error).message}`, context: { job: 'receiving-expiry' } });
    } finally {
      this.running = false;
    }
  }

  /** Exposed for tests and manual runs. */
  async runOnce(now = new Date()): Promise<{ cancelled: number; reminded: number }> {
    const dayAgo = new Date(now.getTime() - DAY_MS);
    const stale = await this.prisma.receiving_sessions.findMany({
      where: { status: 'OPEN', type: 'PURCHASE', created_at: { lt: dayAgo } },
      select: { id: true },
      orderBy: { created_at: 'asc' },
      take: 100,
    });
    let cancelled = 0;
    let reminded = 0;
    for (const { id } of stale) {
      const result = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM receiving_sessions WHERE id = ${id}::uuid FOR UPDATE`;
        if (!locked.length) return null;
        const s = await tx.receiving_sessions.findUniqueOrThrow({
          where: { id },
          include: { ozon_account: { select: { name: true } }, supplier: { select: { name: true } }, staff: true, _count: { select: { units: true, lines: true } } },
        });
        if (s.status !== 'OPEN') return null;
        const source = s.ozon_account?.name ?? s.supplier?.name ?? '—';
        const notify = async (template: 'staff.receiving_auto_cancelled' | 'staff.receiving_open_reminder', extra: object = {}) => {
          if (!s.staff || s.staff.status !== 'active') return;
          await tx.notifications.create({
            data: {
              staff_user_id: s.staff.id,
              chat_id: s.staff.telegram_user_id,
              kind: 'service',
              template,
              payload: { order_number: '', session_id: s.id, source, admin_path: '/inventory?tab=receiving', lang: 'ru', ...extra } as Prisma.InputJsonObject,
            },
          });
        };

        if (s._count.units === 0 && s._count.lines === 0) {
          await tx.receiving_sessions.update({ where: { id }, data: { status: 'CANCELLED' } });
          await this.audit.log({ staffId: null, action: 'receiving.cancelled', entityType: 'receiving_session', entityId: id, after: { voided: 0, reason: 'Автоматически: пустая приёмка старше суток' } }, tx);
          await notify('staff.receiving_auto_cancelled');
          return 'cancelled' as const;
        }
        // not empty: remind the creator at most once a day
        const recent = await tx.notifications.count({
          where: { template: 'staff.receiving_open_reminder', created_at: { gt: new Date(now.getTime() - DAY_MS) }, payload: { path: ['session_id'], equals: id } },
        });
        if (recent) return null;
        await notify('staff.receiving_open_reminder', { count: s._count.units });
        return s.staff?.status === 'active' ? ('reminded' as const) : null;
      });
      if (result === 'cancelled') cancelled++;
      if (result === 'reminded') reminded++;
    }
    return { cancelled, reminded };
  }
}
