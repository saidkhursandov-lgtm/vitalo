import { Bot } from 'grammy';
import type { VitaloApi } from './api-client';

/**
 * Генплан, этап 3 (D-56): login to the admin panel in a browser seen for the first time. The API sends the employee
 * «Подтвердить» (sl:ok:<id>) and «Это не я» (sl:no:<id>); the bot passes the choice on and replaces the message
 * text with the result. The API checks that the same Telegram account answers and that the 3 minutes have not passed.
 */
const TEXT: Record<string, string> = {
  approved: 'Вход подтверждён. Вернитесь в браузер — админка откроется сама.',
  denied: 'Вход отклонён. Администратор получил предупреждение. Если кто-то знает ваш пароль от Telegram — смените его.',
  expired: 'Время подтверждения вышло. Начните вход в браузере заново.',
  already: 'На этот запрос уже ответили.',
  failed: 'Не получилось. Попробуйте войти в браузере ещё раз.',
};

export function installStaffLogin(bot: Bot, { api }: { api: VitaloApi }) {
  bot.on('callback_query:data', async (ctx, next) => {
    const m = /^sl:(ok|no):([0-9a-f-]{36})$/.exec(ctx.callbackQuery.data);
    if (!m) return next();
    let line: string;
    try {
      const { result } = await api.staffLoginDecision(ctx.from.id, m[2], m[1] === 'ok');
      line = TEXT[result] ?? TEXT.already;
    } catch {
      line = TEXT.failed;
    }
    await ctx.answerCallbackQuery({ text: line });
    if (line !== TEXT.failed) await ctx.editMessageText(line).catch(() => undefined);
  });
}
