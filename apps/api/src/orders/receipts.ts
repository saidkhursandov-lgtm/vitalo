import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { dirname, join, resolve } from 'path';
import { uploadDir } from '../storage/file-storage';

/**
 * 3.1: receipts (screenshots or PDFs of a card transfer) the customer sends to the bot.
 * They hold names and card numbers, so they never go to the public uploads folder: RECEIPTS_DIR, by default the
 * «receipts» folder next to the uploads one (server: /var/lib/vitalo/receipts — nginx does not serve it, backup.sh
 * copies it). Only employees see them, through the admin panel or the bot.
 */
export function receiptsDir(config: ConfigService): string {
  return resolve(config.get<string>('RECEIPTS_DIR') ?? join(dirname(uploadDir(config)), 'receipts'));
}

/** What the bot accepts: photos (Telegram sends them as JPEG), image files and PDFs. */
export const RECEIPT_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
/** 10 MB: a phone screenshot or a bank PDF is far smaller; Telegram lets bots download up to 20 MB. */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

/** Reasons a manager picks in the bot when rejecting a receipt; «Другое» is typed by hand. */
export const RECEIPT_REJECT_REASONS = {
  amount: { ru: 'Сумма не совпадает', uz: 'Summa mos kelmaydi' },
  unreadable: { ru: 'Чек не читается', uz: 'Chek o‘qilmaydi' },
  not_received: { ru: 'Платёж не поступил', uz: 'To‘lov kelib tushmagan' },
} as const;
export type ReceiptRejectCode = keyof typeof RECEIPT_REJECT_REASONS;

/** Deep-link payload of «Отправить скриншот чека в бот»: rc_ + the order id without dashes (Telegram allows 64 chars). */
export const receiptStartParam = (orderId: string) => `rc_${orderId.replace(/-/g, '')}`;
export function orderIdFromStartParam(param: string): string | null {
  const m = /^rc_([0-9a-f]{32})$/i.exec(param.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The shop bot's @username for t.me links. Taken from Telegram (getMe) with the token the API already has, so the
 * test bot on the laptop and the real bot on the server each give their own link; TELEGRAM_BOT_USERNAME overrides it.
 * Cached; null while Telegram cannot be reached (then the Mini App simply hides the button).
 */
@Injectable()
export class BotInfoService {
  private readonly logger = new Logger(BotInfoService.name);
  private cached: { username: string | null; at: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  async username(): Promise<string | null> {
    const fixed = this.config.get<string>('TELEGRAM_BOT_USERNAME');
    if (fixed) return fixed.replace(/^@/, '');
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return null;
    const ttl = this.cached?.username ? 3_600_000 : 60_000; // a failure is retried after a minute
    if (this.cached && Date.now() - this.cached.at < ttl) return this.cached.username;
    let username: string | null = null;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(3000) });
      const body = (await res.json()) as { ok?: boolean; result?: { username?: string } };
      username = body.ok ? (body.result?.username ?? null) : null;
    } catch (e) {
      this.logger.warn(`getMe failed: ${(e as Error).message}`);
    }
    this.cached = { username, at: Date.now() };
    return username;
  }

  async receiptLink(orderId: string): Promise<string | null> {
    const name = await this.username();
    return name ? `https://t.me/${name}?start=${receiptStartParam(orderId)}` : null;
  }
}
