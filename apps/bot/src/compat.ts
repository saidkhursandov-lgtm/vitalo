import { Bot, Context, InlineKeyboard } from 'grammy';
import { ApiError, type CompatAnswer, type VitaloApi } from './api-client';

/**
 * 3.4, «Проверить совместимость у специалиста». The API sends admins and specialists the request with quick answers
 * (cp:<c|s|k>:<id>) and «Ответить своим текстом» (cp:t:<id>). The bot only passes the choice on: the API checks the
 * employee, answers the customer and removes the buttons from every staff message of the request.
 * Own text: the employee picks the label first, then the next text message is the answer.
 */
const LABELS: [code: string, label: string][] = [
  ['c', 'Совместимы'],
  ['s', 'Разнести по времени'],
  ['k', 'Нужна консультация'],
];
const LABEL = Object.fromEntries(LABELS) as Record<string, string>;
const VERDICT_LABEL: Record<string, string> = { compatible: 'Совместимы', spread: 'Разнести по времени', consult: 'Нужна консультация специалиста' };

const STAFF = {
  own: 'Ответить своим текстом',
  back: '‹ Назад',
  pickLabel: 'Выберите метку ответа:',
  askText: (label: string) => `Метка: ${label}.\nНапишите ответ клиенту одним сообщением — на языке клиента (указан в запросе). Клиент увидит текст как есть.`,
  answered: (label: string) => `Ответ отправлен клиенту: ${label}`,
  already: (by?: string | null, verdict?: string | null) => `Уже ответил${by ? ` ${by}` : 'и'}${verdict ? `: ${VERDICT_LABEL[verdict] ?? verdict}` : ''}`,
  closed: 'Клиент изменил корзину — этот запрос закрыт, пришёл новый.',
  forbidden: 'Отвечать может только администратор или специалист.',
  failed: 'Не получилось. Попробуйте ещё раз или ответьте в админке («Совместимость»).',
};

export const compatKeyboard = (id: string) =>
  new InlineKeyboard().text(LABELS[0][1], `cp:c:${id}`).text(LABELS[1][1], `cp:s:${id}`).row().text(LABELS[2][1], `cp:k:${id}`).row().text(STAFF.own, `cp:t:${id}`);
const labelKeyboard = (id: string) => {
  const kb = new InlineKeyboard();
  for (const [code, label] of LABELS) kb.text(label, `cp:tl:${code}:${id}`).row();
  return kb.text(STAFF.back, `cp:tb:${id}`);
};

function outcome(a: CompatAnswer): string {
  if (a.result === 'answered') return STAFF.answered(VERDICT_LABEL[a.verdict] ?? a.verdict);
  if (a.result === 'already') return STAFF.already(a.by, a.verdict);
  return STAFF.closed;
}

export function installCompat(bot: Bot, { api }: { api: VitaloApi }) {
  const typing = new Map<number, { id: string; code: string }>();

  async function send(staffId: number, id: string, code: string, text?: string): Promise<{ line: string; alert: boolean }> {
    try {
      return { line: outcome(await api.compatAnswer(staffId, id, code, text)), alert: false };
    } catch (e) {
      return { line: e instanceof ApiError && e.status === 403 ? STAFF.forbidden : STAFF.failed, alert: true };
    }
  }

  bot.on('callback_query:data', async (ctx, next) => {
    const m = /^cp:(c|s|k|t|tb|tl):(?:([csk]):)?([0-9a-f-]{36})$/.exec(ctx.callbackQuery.data);
    if (!m) return next();
    const [, action, code, id] = m;
    if (action === 't') {
      await ctx.editMessageReplyMarkup({ reply_markup: labelKeyboard(id) }).catch(() => undefined);
      return void (await ctx.answerCallbackQuery({ text: STAFF.pickLabel }));
    }
    if (action === 'tb') {
      await ctx.editMessageReplyMarkup({ reply_markup: compatKeyboard(id) }).catch(() => undefined);
      return void (await ctx.answerCallbackQuery());
    }
    if (action === 'tl' && code) {
      typing.set(ctx.from.id, { id, code });
      await ctx.answerCallbackQuery();
      return void (await ctx.reply(STAFF.askText(LABEL[code]), { reply_markup: { force_reply: true } }));
    }
    const res = await send(ctx.from.id, id, action);
    await ctx.answerCallbackQuery({ text: res.line, show_alert: res.alert });
  });

  // the specialist's own text after «Ответить своим текстом» → label
  bot.on('message:text', async (ctx: Context, next) => {
    const from = ctx.from?.id;
    const wait = from ? typing.get(from) : undefined;
    const text = ctx.message?.text ?? '';
    if (!from || !wait || text.startsWith('/')) return next();
    typing.delete(from);
    const res = await send(from, wait.id, wait.code, text);
    await ctx.reply(res.line);
  });
}
