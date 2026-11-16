import type { Bot } from 'grammy';
import type { VitaloApi } from './api-client';

/**
 * 4.2 «Курс заканчивается»: the API sends the reminder with «Повторить» (a Mini App button) and «Не напоминать»
 * (callback cr:off). The bot switches the reminders off and removes only that button; «Повторить» stays.
 */
export const COURSE_OFF_DATA = 'cr:off';

const TEXT = {
  ru: { done: 'Больше не будем напоминать о конце курса. Включить снова можно в профиле.', failed: 'Не получилось. Попробуйте ещё раз.' },
  uz: { done: 'Kurs tugashi haqida boshqa eslatmaymiz. Profilda qayta yoqish mumkin.', failed: 'Bo‘lmadi. Yana urinib ko‘ring.' },
};

export function installCourse(bot: Bot, { api }: { api: VitaloApi }) {
  bot.callbackQuery(COURSE_OFF_DATA, async (ctx) => {
    // the language chosen in the shop (the message came in it); Telegram's own language as a fallback
    const chosen = await api.user(ctx.from.id).then((u) => u.language).catch(() => null);
    const lang = (chosen ?? ctx.from.language_code) === 'uz' ? 'uz' : 'ru';
    try {
      await api.courseReminders(ctx.from.id, false);
    } catch {
      return void (await ctx.answerCallbackQuery({ text: TEXT[lang].failed, show_alert: true }));
    }
    const rows = ctx.callbackQuery.message?.reply_markup?.inline_keyboard ?? [];
    const kept = rows.map((r) => r.filter((b) => !('callback_data' in b) || b.callback_data !== COURSE_OFF_DATA)).filter((r) => r.length);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: kept } }).catch(() => undefined);
    await ctx.answerCallbackQuery({ text: TEXT[lang].done, show_alert: true });
  });
}
