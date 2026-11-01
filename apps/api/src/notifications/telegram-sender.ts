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
  /** Resolves with Telegram's message id (fakes in tests may return nothing). */
  sendMessage(chatId: bigint, text: string, opts?: SendOptions): Promise<number | void>;
  /** 3.4: replaces the text of a sent message and removes its buttons (best effort). */
  editMessage?(chatId: bigint, messageId: number, text: string): Promise<void>;
}

/** A button under the message that opens a Mini App page (Telegram web_app button). */
export interface SendOptions {
  webApp?: { text: string; url: string };
  /** 3.2: an ordinary link button on its own row (e.g. «Спросить специалиста» -> support chat) */
  link?: { text: string; url: string };
  /** 3.4: callback buttons handled by the bot (rows of { text, data }) — the specialist's quick answers */
  buttons?: { text: string; data: string }[][];
  /** 3.4: delivered without a sound (staff at night) */
  silent?: boolean;
}

function keyboard(opts: SendOptions) {
  const rows: object[][] = [];
  if (opts.webApp) rows.push([{ text: opts.webApp.text, web_app: { url: opts.webApp.url } }]);
  if (opts.link) rows.push([{ text: opts.link.text, url: opts.link.url }]);
  for (const row of opts.buttons ?? []) rows.push(row.map((b) => ({ text: b.text, callback_data: b.data })));
  return rows;
}

export const TELEGRAM_SENDER = Symbol('TELEGRAM_SENDER');

/**
 * Sends through the Bot API with the token from config. The token is only put into the request URL —
 * it is never part of an error message, log line or stored error (we only keep Telegram's description).
 */
@Injectable()
export class HttpTelegramSender implements TelegramSender {
  constructor(private readonly config: ConfigService) {}

  async sendMessage(chatId: bigint, text: string, opts: SendOptions = {}): Promise<number> {
    const rows = keyboard(opts);
    const body = await this.call('sendMessage', {
      chat_id: chatId.toString(),
      text,
      link_preview_options: { is_disabled: true },
      ...(opts.silent && { disable_notification: true }),
      ...(rows.length && { reply_markup: { inline_keyboard: rows } }),
    });
    return (body.result as { message_id?: number } | undefined)?.message_id ?? 0;
  }

  async editMessage(chatId: bigint, messageId: number, text: string): Promise<void> {
    await this.call('editMessageText', { chat_id: chatId.toString(), message_id: messageId, text, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } });
  }

  private async call(method: string, payload: object): Promise<{ result?: unknown }> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) throw new TelegramSendError('TELEGRAM_BOT_TOKEN is not configured', false);

    let res: Response;
    try {
      res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      // Network problem / timeout: worth retrying. e.message from fetch never includes the URL.
      throw new TelegramSendError(`Network error: ${(e as Error).name}`, false);
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    if (res.ok && body.ok) return body;

    const code = body.error_code ?? res.status;
    const description = `Telegram ${code}: ${body.description ?? 'unknown error'}`;
    if (code === 429) throw new TelegramSendError(description, false, body.parameters?.retry_after ?? 30);
    // 400 chat not found / 403 blocked by user / deactivated: the same request will never succeed.
    if (code === 400 || code === 403) throw new TelegramSendError(description, true);
    throw new TelegramSendError(description, false);
  }
}
