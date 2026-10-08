import { ArgumentsHost, Catch, HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { TELEGRAM_SENDER, type TelegramSender } from './telegram-sender';

/** The same alert is sent to the tech chat at most once per this period. */
export const TECH_ALERT_INTERVAL_MS = 10 * 60_000;

export interface SystemErrorEntry {
  level: 'error' | 'warn';
  service: string;
  message: string;
  context?: Record<string, unknown>;
}

/** Context keys that are safe to show in the tech chat (no names, phones, chat ids, addresses). */
const SAFE_CONTEXT_KEYS = ['template', 'attempts', 'permanent', 'retry_in_seconds', 'order_number', 'job', 'route', 'status'];

/**
 * Text for the tech chat without secrets and personal data: known secrets are cut out, then anything that
 * looks like a bot token, an e-mail, a phone, a card or a Telegram id (long digit runs) is masked.
 */
export function sanitizeAlert(text: string, secrets: (string | undefined)[] = []): string {
  let s = text;
  for (const secret of secrets) if (secret && secret.length >= 8) s = s.split(secret).join('[скрыто]');
  return s
    .replace(/\d{6,12}:[A-Za-z0-9_-]{30,}/g, '[токен скрыт]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[e-mail скрыт]')
    .replace(/\+?\d[\d\s()-]{7,}\d/g, '[число скрыто]')
    .slice(0, 1500);
}

/**
 * system_errors: every problem is stored; errors and notification failures also go to the Telegram chat
 * TECH_CHAT_ID (empty -> nothing is sent, nothing fails). Same text at most once per 10 minutes.
 */
@Injectable()
export class SystemErrorsService {
  private readonly logger = new Logger('SystemErrors');
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(TELEGRAM_SENDER) private readonly sender: TelegramSender,
  ) {}

  async record(entry: SystemErrorEntry, now = Date.now()): Promise<void> {
    let id: string | null = null;
    try {
      id = (
        await this.prisma.system_errors.create({
          data: { level: entry.level, service: entry.service, message: entry.message.slice(0, 2000), context_json: (entry.context ?? Prisma.JsonNull) as Prisma.InputJsonValue },
        })
      ).id;
    } catch (e) {
      this.logger.error(`Could not store a system error: ${(e as Error).message}`);
    }
    if (await this.alert(entry, now)) {
      if (id) await this.prisma.system_errors.update({ where: { id }, data: { notified_at: new Date(now) } }).catch(() => undefined);
    }
  }

  /** Returns true when a message was sent to the tech chat. Never throws. */
  async alert(entry: SystemErrorEntry, now = Date.now()): Promise<boolean> {
    const chat = this.config.get<string>('TECH_CHAT_ID')?.trim();
    if (!chat || !/^-?\d{1,20}$/.test(chat)) return false;
    const secrets = [
      this.config.get<string>('TELEGRAM_BOT_TOKEN'),
      this.config.get<string>('BOT_API_SECRET'),
      this.config.get<string>('DATABASE_URL'),
      this.config.get<string>('YANDEX_API_KEY'),
      this.config.get<string>('YANDEX_WEBHOOK_SECRET'),
    ];
    // Rate limit by the shape of the message (numbers ignored), so a burst of the same failure is one alert.
    const key = `${entry.level}|${entry.service}|${entry.message.replace(/\d+/g, '#')}`;
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < TECH_ALERT_INTERVAL_MS) return false;
    this.lastSent.set(key, now);
    if (this.lastSent.size > 1000) this.lastSent.clear();

    const context = Object.entries(entry.context ?? {})
      .filter(([k, v]) => SAFE_CONTEXT_KEYS.includes(k) && v !== null && v !== undefined)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ');
    const text = sanitizeAlert(`${entry.level === 'error' ? '🔴' : '🟠'} VITALO · ${entry.service}\n${entry.message}${context ? `\n${context}` : ''}`, secrets);
    try {
      await this.sender.sendMessage(BigInt(chat), text);
      return true;
    } catch (e) {
      this.logger.warn(`Tech chat alert failed: ${sanitizeAlert((e as Error).message, secrets)}`);
      return false;
    }
  }
}

/** Unexpected (500) errors of the API are stored and reported; normal 4xx answers are not. */
@Catch()
export class UnexpectedErrorFilter extends BaseExceptionFilter {
  constructor(
    adapter: ConstructorParameters<typeof BaseExceptionFilter>[0],
    private readonly errors: SystemErrorsService,
  ) {
    super(adapter);
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const isHttp = exception instanceof HttpException;
    if (!isHttp || exception.getStatus() >= 500) {
      const req = host.getType() === 'http' ? host.switchToHttp().getRequest<Request>() : null;
      const route = req ? `${req.method} ${(req.originalUrl ?? req.url).split('?')[0].replace(/[0-9a-f-]{36}/gi, ':id')}` : undefined;
      const err = exception instanceof Error ? exception : new Error(String(exception));
      void this.errors.record({ level: 'error', service: 'api', message: `${err.name}: ${err.message}`, context: { route } });
    }
    super.catch(exception, host);
  }
}
