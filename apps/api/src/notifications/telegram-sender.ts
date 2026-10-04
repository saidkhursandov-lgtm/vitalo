import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Why a message was not delivered; decides whether the queue retries. */
export class TelegramSendError extends Error {
  constructor(
    message: string,
    /** true = retrying is pointless (user blocked the bot, chat does not exist...) */
    public readonly permanent: boolean,
    /** seconds Telegram asked us to wait (HTTP 429) */
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export interface TelegramSender {
  sendMessage(chatId: bigint, text: string, opts?: SendOptions): Promise<void>;
}

/** A button under the message that opens a Mini App page (Telegram web_app button). */
export interface SendOptions {
  webApp?: { text: string; url: string };
}

export const TELEGRAM_SENDER = Symbol('TELEGRAM_SENDER');

/**
 * Sends through the Bot API with the token from config. The token is only put into the request URL —
 * it is never part of an error message, log line or stored error (we only keep Telegram's description).
 */
@Injectable()
export class HttpTelegramSender implements TelegramSender {
  constructor(private readonly config: ConfigService) {}

  async sendMessage(chatId: bigint, text: string, opts: SendOptions = {}): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) throw new TelegramSendError('TELEGRAM_BOT_TOKEN is not configured', false);

    let res: Response;
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId.toString(),
          text,
          link_preview_options: { is_disabled: true },
          ...(opts.webApp && { reply_markup: { inline_keyboard: [[{ text: opts.webApp.text, web_app: { url: opts.webApp.url } }]] } }),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      // Network problem / timeout: worth retrying. e.message from fetch never includes the URL.
      throw new TelegramSendError(`Network error: ${(e as Error).name}`, false);
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    if (res.ok && body.ok) return;

    const code = body.error_code ?? res.status;
    const description = `Telegram ${code}: ${body.description ?? 'unknown error'}`;
    if (code === 429) throw new TelegramSendError(description, false, body.parameters?.retry_after ?? 30);
    // 400 chat not found / 403 blocked by user / deactivated: the same request will never succeed.
    if (code === 400 || code === 403) throw new TelegramSendError(description, true);
    throw new TelegramSendError(description, false);
  }
}
