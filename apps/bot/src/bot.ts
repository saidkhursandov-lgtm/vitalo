import { Bot, Context, InlineKeyboard, Keyboard } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { UserSummary, VitaloApi } from './api-client';
import { bothLangs, langFromTelegram, money, t, type Lang, type TextKey } from './texts';

export interface BotDeps {
  token: string;
  api: VitaloApi;
  /** Current https URLs (they change with every dev tunnel, so they are read on each use). */
  urls: { miniApp: () => string | null; admin: () => string | null };
  /** Pass in tests to skip the getMe call. */
  botInfo?: UserFromGetMe;
}

/** Telegram allows these characters in deep-link payloads; anything else is ignored. */
export const REFERRAL_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Mini App URL for a page, with the referral code as ?startapp= (the Mini App forwards it as start_param). */
export function miniAppLink(base: string, path = '/', startParam?: string): string {
  const url = new URL(path, `${base}/`);
  if (startParam && REFERRAL_RE.test(startParam)) url.searchParams.set('startapp', startParam);
  return url.toString();
}

/**
 * Main menu (Appendix 2, §2): Магазин, Мои заказы, Акции, Мой профиль, Поддержка, О VITALO.
 * "Магазин" opens the Mini App through an inline web_app button: unlike reply-keyboard buttons it gives
 * the Mini App full, signed initData. The menu button (bottom-left) is set by the tunnel script.
 */
export function createBot({ token, api, urls, botInfo }: BotDeps): Bot {
  const bot = new Bot(token, botInfo ? { botInfo } : undefined);

  /** Language: the one chosen in the shop, else Telegram's. */
  async function context(ctx: Context): Promise<{ lang: Lang; user: UserSummary | null }> {
    const fallback = langFromTelegram(ctx.from?.language_code);
    if (!ctx.from) return { lang: fallback, user: null };
    try {
      const user = await api.user(ctx.from.id);
      return { lang: user.registered && user.language ? user.language : fallback, user };
    } catch {
      return { lang: fallback, user: null };
    }
  }

  const menu = (lang: Lang) =>
    new Keyboard()
      .text(t(lang, 'menu.shop'))
      .text(t(lang, 'menu.orders'))
      .row()
      .text(t(lang, 'menu.promos'))
      .text(t(lang, 'menu.profile'))
      .row()
      .text(t(lang, 'menu.support'))
      .text(t(lang, 'menu.about'))
      .resized()
      .persistent();

  /** Inline button opening the Mini App on `path`; null when no https URL is known yet. */
  const shopButton = (lang: Lang, label: TextKey, path = '/', startParam?: string) => {
    const base = urls.miniApp();
    return base ? new InlineKeyboard().webApp(t(lang, label), miniAppLink(base, path, startParam)) : null;
  };

  async function replyWithShop(ctx: Context, lang: Lang, text: string, label: TextKey = 'openShop', path = '/', startParam?: string) {
    const kb = shopButton(lang, label, path, startParam);
    if (kb) await ctx.reply(text, { reply_markup: kb });
    else await ctx.reply(`${text}\n\n${t(lang, 'shopUnavailable')}`);
  }

  bot.command('start', async (ctx) => {
    const { lang } = await context(ctx);
    const payload = ctx.match.trim(); // /start <referral code>
    const ref = REFERRAL_RE.test(payload) ? payload : undefined;
    await ctx.reply(t(lang, 'welcome', { name: ctx.from?.first_name ?? '' }), { reply_markup: menu(lang) });
    await replyWithShop(ctx, lang, t(lang, 'openShopHint'), 'openShop', '/', ref);
  });

  const showShop = async (ctx: Context) => {
    const { lang } = await context(ctx);
    await replyWithShop(ctx, lang, t(lang, 'openShopHint'));
  };

  const showOrders = async (ctx: Context) => {
    const { lang, user } = await context(ctx);
    if (!user) return void (await ctx.reply(t(lang, 'apiDown')));
    if (user.blocked) return void (await ctx.reply(t(lang, 'blocked')));
    if (!user.registered) return replyWithShop(ctx, lang, t(lang, 'notRegistered'));
    if (!user.orders?.length) return replyWithShop(ctx, lang, t(lang, 'ordersEmpty'));
    const lines = user.orders.map((o) => `• ${o.order_number} — ${t(lang, `status.${o.status}` as TextKey)}, ${money(o.total_uzs, lang)}`);
    await replyWithShop(ctx, lang, `${t(lang, 'ordersTitle')}\n${lines.join('\n')}`, 'allOrders', '/orders');
  };

  const showProfile = async (ctx: Context) => {
    const { lang, user } = await context(ctx);
    if (!user) return void (await ctx.reply(t(lang, 'apiDown')));
    if (user.blocked) return void (await ctx.reply(t(lang, 'blocked')));
    if (!user.registered) return replyWithShop(ctx, lang, t(lang, 'notRegistered'));
    const text = t(lang, 'profile', {
      name: user.first_name ?? '',
      bonus: money(user.bonus_balance_uzs ?? 0, lang),
      orders: user.orders_total ?? 0,
      favorites: user.favorites_count ?? 0,
      addresses: user.addresses_count ?? 0,
    });
    const recent = (user.orders ?? []).slice(0, 3).map((o) => `• ${o.order_number} — ${t(lang, `status.${o.status}` as TextKey)}`);
    await replyWithShop(ctx, lang, recent.length ? `${text}\n\n${recent.join('\n')}` : text, 'openProfile', '/profile');
  };

  const showSupport = async (ctx: Context) => {
    const { lang } = await context(ctx);
    try {
      const info = await api.info();
      await ctx.reply(info.support_contact ? t(lang, 'support', { contact: info.support_contact }) : t(lang, 'supportMissing'));
    } catch {
      await ctx.reply(t(lang, 'apiDown'));
    }
  };

  const showAbout = async (ctx: Context) => {
    const { lang } = await context(ctx);
    try {
      const info = await api.info();
      await replyWithShop(ctx, lang, lang === 'uz' ? info.about_uz : info.about_ru);
    } catch {
      await ctx.reply(t(lang, 'apiDown'));
    }
  };

  bot.hears(bothLangs('menu.shop'), showShop);
  bot.hears(bothLangs('menu.orders'), showOrders);
  bot.hears(bothLangs('menu.promos'), async (ctx) => {
    const { lang } = await context(ctx);
    await replyWithShop(ctx, lang, t(lang, 'promos'));
  });
  bot.hears(bothLangs('menu.profile'), showProfile);
  bot.hears(bothLangs('menu.support'), showSupport);
  bot.hears(bothLangs('menu.about'), showAbout);
  bot.command('orders', showOrders);
  bot.command('profile', showProfile);
  bot.command('help', showSupport);

  /** Hidden command: employees get a button that opens the admin panel inside Telegram (staff login by initData). */
  bot.command('admin', async (ctx) => {
    const { lang } = await context(ctx);
    let staff;
    try {
      staff = await api.staff(ctx.from!.id);
    } catch {
      return void (await ctx.reply(t(lang, 'apiDown')));
    }
    if (!staff.is_staff) return void (await ctx.reply(t(lang, 'adminOnly')));
    const url = urls.admin();
    if (!url) return void (await ctx.reply(t(lang, 'adminUnavailable')));
    await ctx.reply(t(lang, 'adminOpen', { role: t(lang, `role.${staff.role}` as TextKey) }), {
      reply_markup: new InlineKeyboard().webApp(t(lang, 'adminButton'), `${url}/`),
    });
  });

  bot.on('message', async (ctx) => {
    const { lang } = await context(ctx);
    await ctx.reply(t(lang, 'useMenu'), { reply_markup: menu(lang) });
  });

  return bot;
}

/** Command lists shown by Telegram, per language. */
export function commandsFor(lang: Lang) {
  return (['start', 'orders', 'profile', 'help'] as const).map((c) => ({ command: c, description: t(lang, `cmd.${c}`) }));
}
