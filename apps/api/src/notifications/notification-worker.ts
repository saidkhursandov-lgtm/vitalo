import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma, notifications } from '@prisma/client';
import { VERDICT_CODES, VERDICT_LABELS, VERDICTS } from '../compat/compat';
import { PrismaService } from '../prisma/prisma.service';
import { ADMIN_BUTTON, MAP_BUTTON, SUPPORT_BUTTON, openButtonText, renderNotification, type TemplatePayload } from './notification-templates';
import { TELEGRAM_SENDER, TelegramSendError, type TelegramSender } from './telegram-sender';
import { ConfigService } from '@nestjs/config';
import { adminUrl, miniAppUrl } from './mini-app-url';
import { SystemErrorsService } from './system-errors';

const BATCH = 20; // Telegram allows ~30 messages/second per bot
export const MAX_ATTEMPTS = 5;
/** Wait before attempt N+1 (seconds): 30s, 2m, 10m, 30m. */
export const BACKOFF_SECONDS = [30, 120, 600, 1800];
/** A "sending" row older than this was abandoned by a crashed worker and is picked up again. */
const STUCK_MS = 5 * 60_000;

/** 3.2: marketing is not sent from 22:00 to 08:00 Tashkent time (UTC+5, no daylight saving). */
const QUIET_FROM_HOUR = 22;
const QUIET_TO_HOUR = 8;
const TASHKENT_OFFSET_MS = 5 * 3600_000;

/** Inside the quiet hours: the next 08:00 Tashkent time; otherwise null. */
export function quietUntil(now: Date): Date | null {
  const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  const h = local.getUTCHours();
  if (h >= QUIET_TO_HOUR && h < QUIET_FROM_HOUR) return null;
  const morning = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), QUIET_TO_HOUR) - TASHKENT_OFFSET_MS);
  return h >= QUIET_FROM_HOUR ? new Date(morning.getTime() + 24 * 3600_000) : morning;
}

/** 3.4: quick answers of the specialist (the bot handles cp:<code>:<id>, cp:t:<id> = own text). */
export function compatButtons(id: string) {
  const quick = VERDICTS.map((v) => ({ text: VERDICT_LABELS[v].ru, data: `cp:${VERDICT_CODES[v]}:${id}` }));
  return [[quick[0], quick[1]], [quick[2]], [{ text: 'Ответить своим текстом', data: `cp:t:${id}` }]];
}

export interface ProcessResult {
  sent: number;
  failed: number;
  retried: number;
  skipped: number;
  /** 3.2: marketing put off until 08:00 */
  deferred: number;
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
    private readonly errors: SystemErrorsService,
    private readonly config: ConfigService,
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

  /** `only` (tests): deliver just these rows, so parallel suites never take each other's messages. */
  async processOnce(now = new Date(), only?: string[]): Promise<ProcessResult> {
    const result: ProcessResult = { sent: 0, failed: 0, retried: 0, skipped: 0, deferred: 0 };
    const batch = await this.prisma.$queryRaw<notifications[]>`
      UPDATE notifications SET status = 'sending'
      WHERE id IN (
        SELECT id FROM notifications
        WHERE ((status = 'queued' AND next_attempt_at <= ${now})
           OR (status = 'sending' AND next_attempt_at <= ${new Date(now.getTime() - STUCK_MS)}))
          ${only ? Prisma.sql`AND id = ANY(${only}::uuid[])` : Prisma.empty}
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
        // 3.2: no marketing at night (22:00–08:00 Tashkent): put it off until the morning, no attempt is spent
        const morning = quietUntil(now);
        if (morning) {
          await this.prisma.notifications.update({ where: { id: n.id }, data: { status: 'queued', next_attempt_at: morning } });
          result.deferred++;
          continue;
        }
      }
      try {
        const payload = (n.payload ?? {}) as unknown as TemplatePayload;
        const lang = payload.lang === 'uz' ? 'uz' : 'ru';
        const text = renderNotification(n.template, payload);
        const base = miniAppUrl(this.config);
        const admin = payload.admin_path ? adminUrl(this.config) : null;
        const button =
          payload.open_path && base
            ? { text: openButtonText(payload.open_button, lang), url: `${base}${payload.open_path}` }
            : payload.admin_path && admin
              ? { text: ADMIN_BUTTON, url: `${admin}${payload.admin_path}` }
              : undefined;
        const link = payload.support_url
          ? { text: SUPPORT_BUTTON[lang], url: payload.support_url }
          : payload.map_url
            ? { text: MAP_BUTTON[lang], url: payload.map_url }
            : undefined;
        // 3.4: the specialist answers with buttons of the bot; at night the message comes without a sound
        const compat = n.template === 'staff.compat_request' && payload.compat_id ? { buttons: compatButtons(payload.compat_id), silent: !!quietUntil(now) } : {};
        const messageId = await this.sender.sendMessage(n.chat_id, text, { ...(button && { webApp: button }), ...(link && { link }), ...compat });
        await this.prisma.notifications.update({
          where: { id: n.id },
          data: {
            status: 'sent',
            sent_at: new Date(),
            attempts: n.attempts + 1,
            error: null,
            ...(compat.buttons && messageId && { payload: { ...payload, tg_message_id: messageId } as unknown as Prisma.InputJsonObject }),
          },
        });
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
    await this.errors.record({
      level: giveUp ? 'error' : 'warn',
      service: 'notifications',
      message: `${giveUp ? 'Notification failed' : 'Notification will be retried'}: ${err.message}`,
      context: { notification_id: n.id, template: n.template, attempts, permanent: err.permanent, retry_in_seconds: giveUp ? null : delay },
    });
    return giveUp ? 'failed' : 'retried';
  }
}
