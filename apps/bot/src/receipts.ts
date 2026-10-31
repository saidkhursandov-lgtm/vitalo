import { Bot, Context, InlineKeyboard } from 'grammy';
import { ApiError, type ReceiptDecision, type VitaloApi } from './api-client';
import { money, t, type Lang, type TextKey } from './texts';

/** /start payload of «Отправить скриншот чека в бот»: rc_ + the order id without dashes. */
export function orderIdFromStart(payload: string): string | null {
  const m = /^rc_([0-9a-f]{32})$/i.exec(payload.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_BYTES = 10 * 1024 * 1024;

/** Reasons offered to the manager (the API keeps the same codes and texts). */
const REASONS: [code: string, label: string][] = [
  ['amount', 'Сумма не совпадает'],
  ['unreadable', 'Чек не читается'],
  ['not_received', 'Платёж не поступил'],
];

/** Staff side is in Russian, like the other staff messages of the shop. */
const STAFF = {
  confirm: 'Подтвердить оплату',
  reject: 'Отклонить',
  other: 'Другое — написать',
  back: '‹ Назад',
  askReason: 'Напишите причину отказа одним сообщением — клиент её увидит.',
  confirmed: (by: string) => `Оплата подтверждена — ${by}`,
  rejected: (by: string, reason: string) => `Чек отклонён — ${by}. Причина: ${reason}`,
  alreadyConfirmed: (by?: string | null) => `Уже подтверждено${by ? ` (${by})` : ''}`,
  alreadyRejected: (by?: string | null) => `Чек уже отклонён${by ? ` (${by})` : ''}`,
  alreadyPaid: 'Заказ уже оплачен',
  forbidden: 'Проверять чеки может только менеджер или администратор.',
  failed: 'Не получилось. Попробуйте ещё раз или откройте заказ в админке.',
};

const ERRORS: Record<string, TextKey> = {
  ORDER_PAID: 'receipt.paid',
  ORDER_CANCELLED: 'receipt.cancelled',
  RESERVATION_EXPIRED: 'receipt.expired',
  NOT_CARD_TRANSFER: 'receipt.notCard',
  ORDER_NOT_FOUND: 'receipt.noOrder',
  NOT_REGISTERED: 'receipt.noOrder',
  FILE_TYPE: 'receipt.badType',
  FILE_TOO_LARGE: 'receipt.tooBig',
};
const errorKey = (e: unknown): TextKey => (e instanceof ApiError && e.code && ERRORS[e.code]) || 'receipt.failed';

export const staffKeyboard = (id: string) => new InlineKeyboard().text(STAFF.confirm, `rc:ok:${id}`).row().text(STAFF.reject, `rc:no:${id}`);
const reasonsKeyboard = (id: string) => {
  const kb = new InlineKeyboard();
  for (const [code, label] of REASONS) kb.text(label, `rc:r:${code}:${id}`).row();
  return kb.text(STAFF.other, `rc:rt:${id}`).row().text(STAFF.back, `rc:bk:${id}`);
};

export interface ReceiptDeps {
  api: VitaloApi;
  /** Downloads a Telegram file by its file_id (faked in tests). */
  download: (fileId: string) => Promise<Uint8Array>;
  lang: (ctx: Context) => Promise<Lang>;
}

/**
 * 3.1, «Скриншот чека в боте». The customer comes from the payment screen (/start rc_<order>) and sends a photo or a
 * PDF; the API stores it and names the managers / admins, who get it here with «Подтвердить оплату» / «Отклонить».
 * Which order a photo belongs to is remembered for a day; without it the API takes the customer's latest order waiting
 * for a card transfer. A typed rejection reason is the employee's next text message.
 */
export function installReceipts(bot: Bot, { api, download, lang }: ReceiptDeps) {
  const forOrder = new Map<number, { orderId: string; at: number }>();
  const typing = new Map<number, { receiptId: string; chatId: number; messageId: number; caption: string }>();
  const DAY = 24 * 3600_000;

  /** /start rc_<order>: true when handled. */
  async function start(ctx: Context, payload: string): Promise<boolean> {
    const orderId = orderIdFromStart(payload);
    if (!orderId || !ctx.from) return false;
    const l = await lang(ctx);
    try {
      const target = await api.receiptStart(ctx.from.id, orderId);
      forOrder.set(ctx.from.id, { orderId: target.order_id, at: Date.now() });
      await ctx.reply(t(target.lang ?? l, 'receipt.ask', { number: target.order_number, sum: money(target.total_uzs, target.lang ?? l) }));
    } catch (e) {
      await ctx.reply(t(l, errorKey(e)));
    }
    return true;
  }

  async function receive(ctx: Context, file: { file_id: string; file_unique_id: string; file_size?: number }, mime: string, kind: 'photo' | 'document') {
    if (!ctx.from) return;
    const l = await lang(ctx);
    if (!TYPES.has(mime)) return void (await ctx.reply(t(l, 'receipt.badType')));
    if ((file.file_size ?? 0) > MAX_BYTES) return void (await ctx.reply(t(l, 'receipt.tooBig')));
    const remembered = forOrder.get(ctx.from.id);
    const orderId = remembered && Date.now() - remembered.at < DAY ? remembered.orderId : null;
    let saved;
    try {
      const data = await download(file.file_id);
      saved = await api.sendReceipt(ctx.from.id, orderId, { data, mime, file_id: file.file_id, file_unique_id: file.file_unique_id });
    } catch (e) {
      return void (await ctx.reply(t(l, errorKey(e))));
    }
    const cl = saved.lang ?? l;
    if (saved.result === 'duplicate') return void (await ctx.reply(t(cl, 'receipt.duplicate')));
    await ctx.reply(t(cl, 'receipt.got', { number: saved.order_number, hours: saved.check_within_hours, from: saved.check_hours.from, to: saved.check_hours.to }));
    const caption = saved.caption ?? `Чек по заказу №${saved.order_number}`;
    for (const s of saved.staff) {
      const opts = { caption, reply_markup: staffKeyboard(saved.receipt_id) };
      try {
        if (kind === 'photo') await ctx.api.sendPhoto(s.telegram_id, file.file_id, opts);
        else await ctx.api.sendDocument(s.telegram_id, file.file_id, opts);
      } catch {
        // an employee who blocked the bot must not stop the others
      }
    }
  }

  /** The receipt message after a decision: the outcome under the caption, no buttons. */
  async function settle(ctx: Context, caption: string, line: string, where?: { chatId: number; messageId: number }) {
    const text = `${caption}\n\n${line}`;
    try {
      if (where) await ctx.api.editMessageCaption(where.chatId, where.messageId, { caption: text, reply_markup: new InlineKeyboard() });
      else await ctx.editMessageCaption({ caption: text, reply_markup: new InlineKeyboard() });
    } catch {
      // the message is too old or already changed: the answer to the button is enough
    }
  }

  const outcome = (d: ReceiptDecision, by: string): string =>
    d.result === 'confirmed'
      ? STAFF.confirmed(by)
      : d.result === 'rejected'
        ? STAFF.rejected(by, d.reason ?? '')
        : d.result === 'already_confirmed'
          ? STAFF.alreadyConfirmed(d.by)
          : d.result === 'already_rejected'
            ? STAFF.alreadyRejected(d.by)
            : STAFF.alreadyPaid;

  async function decide(ctx: Context, receiptId: string, run: () => Promise<ReceiptDecision>, where?: { chatId: number; messageId: number; caption: string }) {
    const by = ctx.from?.first_name ?? 'сотрудник';
    try {
      const d = await run();
      const line = outcome(d, by);
      await settle(ctx, where?.caption ?? ctx.callbackQuery?.message?.caption ?? '', line, where);
      return line;
    } catch (e) {
      return e instanceof ApiError && e.status === 403 ? STAFF.forbidden : STAFF.failed;
    }
  }

  bot.on('callback_query:data', async (ctx, next) => {
    const m = /^rc:(ok|no|bk|rt|r):(?:([a-z_]+):)?([0-9a-f-]{36})$/.exec(ctx.callbackQuery.data);
    if (!m) return next();
    const [, action, code, id] = m;
    const staffId = ctx.from.id;
    if (action === 'no') {
      await ctx.editMessageReplyMarkup({ reply_markup: reasonsKeyboard(id) }).catch(() => undefined);
      return void (await ctx.answerCallbackQuery());
    }
    if (action === 'bk') {
      await ctx.editMessageReplyMarkup({ reply_markup: staffKeyboard(id) }).catch(() => undefined);
      return void (await ctx.answerCallbackQuery());
    }
    if (action === 'rt') {
      const msg = ctx.callbackQuery.message;
      if (msg) typing.set(staffId, { receiptId: id, chatId: msg.chat.id, messageId: msg.message_id, caption: msg.caption ?? '' });
      await ctx.answerCallbackQuery();
      return void (await ctx.reply(STAFF.askReason, { reply_markup: { force_reply: true } }));
    }
    const line = await decide(ctx, id, () => (action === 'ok' ? api.confirmReceipt(staffId, id) : api.rejectReceipt(staffId, id, { code })));
    await ctx.answerCallbackQuery({ text: line, show_alert: line === STAFF.forbidden || line === STAFF.failed });
  });

  // the employee's typed reason («Другое — написать»)
  bot.on('message:text', async (ctx, next) => {
    const wait = typing.get(ctx.from.id);
    if (!wait || ctx.message.text.startsWith('/')) return next();
    typing.delete(ctx.from.id);
    const line = await decide(ctx, wait.receiptId, () => api.rejectReceipt(ctx.from.id, wait.receiptId, { text: ctx.message.text }), wait);
    await ctx.reply(line);
  });

  bot.on('message:photo', async (ctx) => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1]; // the largest size
    await receive(ctx, photo, 'image/jpeg', 'photo');
  });
  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    await receive(ctx, doc, (doc.mime_type ?? '').toLowerCase(), 'document');
  });

  return { start };
}
