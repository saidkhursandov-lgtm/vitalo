import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { notifications } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { renderNotification, type TemplatePayload } from './notification-templates';
import { TELEGRAM_SENDER, TelegramSendError, type TelegramSender } from './telegram-sender';

const BATCH = 20; // Telegram allows ~30 messages/second per bot
export const MAX_ATTEMPTS = 5;
/** Wait before attempt N+1 (seconds): 30s, 2m, 10m, 30m. */
export const BACKOFF_SECONDS = [30, 120, 600, 1800];
/** A "sending" row older than this was abandoned by a crashed worker and is picked up again. */
const STUCK_MS = 5 * 60_000;

export interface ProcessResult {
  sent: number;
  failed: number;
  retried: number;
  skipped: number;
}

/**
 * Delivers queued notifications with retries. Safe with several API instances: rows are claimed with
 * FOR UPDATE SKIP LOCKED, so one message is never sent twice. Every failure is written to system_errors.
 */
@Injectable()
export class NotificationWorker {
  private readonly logger = new Logger(NotificationWorker.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(TELEGRAM_SENDER) private readonly sender: TelegramSender,
  ) {}

  @Interval('notifications', 3_000)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.processOnce();
    } catch (e) {
      this.logger.error('Notification worker failed', e as Error);
    } finally {
      this.running = false;
    }
  }

  async processOnce(now = new Date()): Promise<ProcessResult> {
    const result: ProcessResult = { sent: 0, failed: 0, retried: 0, skipped: 0 };
    const batch = await this.prisma.$queryRaw<notifications[]>`
      UPDATE notifications SET status = 'sending'
      WHERE id IN (
        SELECT id FROM notifications
        WHERE (status = 'queued' AND next_attempt_at <= ${now})
           OR (status = 'sending' AND next_attempt_at <= ${new Date(now.getTime() - STUCK_MS)})
        ORDER BY created_at
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`;
    // RETURNING has no guaranteed order; a customer must get "paid" before "delivered".
    batch.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    for (const n of batch) {
      // Marketing respects the opt-out; service messages (orders, payments) are always sent.
      if (n.kind === 'marketing' && n.user_id) {
        const user = await this.prisma.users.findUnique({ where: { id: n.user_id } });
        if (!user?.marketing_opt_in) {
          await this.prisma.notifications.update({ where: { id: n.id }, data: { status: 'skipped', error: 'marketing opt-out' } });
          result.skipped++;
          continue;
        }
      }
      try {
        const text = renderNotification(n.template, (n.payload ?? {}) as unknown as TemplatePayload);
        await this.sender.sendMessage(n.chat_id, text);
        await this.prisma.notifications.update({ where: { id: n.id }, data: { status: 'sent', sent_at: new Date(), attempts: n.attempts + 1, error: null } });
        result.sent++;
      } catch (e) {
        const outcome = await this.handleFailure(n, e, now);
        result[outcome]++;
      }
    }
    return result;
  }

  private async handleFailure(n: notifications, e: unknown, now: Date): Promise<'failed' | 'retried'> {
    const err = e instanceof TelegramSendError ? e : new TelegramSendError((e as Error)?.message ?? String(e), true);
    const attempts = n.attempts + 1;
    const giveUp = err.permanent || attempts >= MAX_ATTEMPTS;
    const delay = err.retryAfter ?? BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];

    await this.prisma.notifications.update({
      where: { id: n.id },
      data: giveUp
        ? { status: 'failed', attempts, error: err.message }
        : { status: 'queued', attempts, error: err.message, next_attempt_at: new Date(now.getTime() + delay * 1000) },
    });
    await this.prisma.system_errors.create({
      data: {
        level: giveUp ? 'error' : 'warn',
        service: 'notifications',
        message: `${giveUp ? 'Notification failed' : 'Notification will be retried'}: ${err.message}`,
        context_json: { notification_id: n.id, template: n.template, attempts, permanent: err.permanent, retry_in_seconds: giveUp ? null : delay },
      },
    });
    return giveUp ? 'failed' : 'retried';
  }
}
