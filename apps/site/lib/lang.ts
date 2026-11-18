import { cookies, headers } from 'next/headers';
import { isLang, LANG_COOKIE } from './i18n';
import type { Lang } from './types';

/** The language of this visit: the cookie set by the RU/UZ switch, else the browser's language, else Russian. */
export async function getLang(): Promise<Lang> {
  const c = (await cookies()).get(LANG_COOKIE)?.value;
  if (isLang(c)) return c;
  const accept = (await headers()).get('accept-language') ?? '';
  return /^uz\b/i.test(accept.trim()) ? 'uz' : 'ru';
}

/** The bot that confirms sign-in and opens the Mini App: the test bot locally, @vitalo_uz_bot on the server. */
export const botUsername = () => process.env.BOT_USERNAME || (process.env.NODE_ENV === 'production' ? 'vitalo_uz_bot' : 'vitalo_store_bot');
export const siteUrl = () => (process.env.SITE_URL || 'https://vitalo.uz').replace(/\/$/, '');
/** Release 6.6: where the Mini App lives (app.vitalo.uz); a Telegram visit to the site goes there. */
export const miniAppUrl = () => (process.env.MINIAPP_URL || '').trim() || null;
