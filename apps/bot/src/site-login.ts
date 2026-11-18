import type { Context } from 'grammy';
import type { VitaloApi } from './api-client';
import { langFromTelegram, type Lang } from './texts';

/**
 * Release 6 «Сайт» (D-30): «Войти через Telegram» on vitalo.uz opens t.me/<bot>?start=login_<id>. Pressing «Start»
 * signs that browser in with this Telegram account (the API checks the 5 minutes and creates the customer if new).
 */
export const SITE_LOGIN_RE = /^login_([0-9a-f]{32})$/;

/** «Продолжить в Telegram» on the site: /start p_<product slug or id>, /start o_<order id> or /start cart (Telegram allows [A-Za-z0-9_-], 64 chars). */
export const SITE_LINK_RE = /^(?:p_([a-z0-9-]{1,62})|o_([0-9a-f-]{36})|cart)$/;

const TEXT: Record<Lang, Record<string, string>> = {
  ru: {
    approved: 'Вход на сайт vitalo.uz подтверждён. Вернитесь в браузер — сайт откроется сам.',
    expired: 'Ссылка для входа устарела. Нажмите «Войти через Telegram» на сайте ещё раз.',
    already: 'Этот вход уже подтверждён.',
    blocked: 'Вход невозможен: аккаунт заблокирован. Напишите в поддержку.',
    failed: 'Не получилось подтвердить вход. Попробуйте ещё раз через минуту.',
  },
  uz: {
    approved: 'vitalo.uz saytiga kirish tasdiqlandi. Brauzerga qayting — sayt o‘zi ochiladi.',
    expired: 'Kirish havolasi eskirgan. Saytda «Telegram orqali kirish» tugmasini yana bosing.',
    already: 'Bu kirish allaqachon tasdiqlangan.',
    blocked: 'Kirish mumkin emas: akkaunt bloklangan. Qo‘llab-quvvatlash xizmatiga yozing.',
    failed: 'Kirishni tasdiqlab bo‘lmadi. Bir daqiqadan so‘ng qayta urinib ko‘ring.',
  },
};

/** Returns a handler: true when the payload was a site login (answered here), false for every other /start. */
export function siteLoginHandler(api: VitaloApi) {
  return async (ctx: Context, payload: string): Promise<boolean> => {
    const m = SITE_LOGIN_RE.exec(payload);
    if (!m || !ctx.from || !api.customerLogin) return false;
    const fallback = langFromTelegram(ctx.from.language_code);
    let text: string;
    try {
      const { result, lang } = await api.customerLogin(m[1], {
        id: ctx.from.id,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
        username: ctx.from.username,
        language_code: ctx.from.language_code,
      });
      const l: Lang = lang === 'uz' ? 'uz' : 'ru';
      text = TEXT[l][result] ?? TEXT[l].failed;
    } catch {
      text = TEXT[fallback].failed;
    }
    await ctx.reply(text);
    return true;
  };
}
