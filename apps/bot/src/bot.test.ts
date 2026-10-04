import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import type { ShopInfo, StaffInfo, UserSummary, VitaloApi } from './api-client';
import { commandsFor, createBot, miniAppLink } from './bot';
import { setMenuButton } from './menu-button';
import { TEXTS } from './texts';
import { extractTunnelUrl } from './tunnel';

const MINI = 'https://abc-def.trycloudflare.com';
const ADMIN = 'https://adm-xyz.trycloudflare.com';

interface Call {
  method: string;
  payload: Record<string, any>;
}

/** A bot wired to a fake Telegram (records outgoing calls) and a fake VITALO API. */
function setup(opts: { user?: Partial<UserSummary> | 'down'; staff?: StaffInfo; info?: Partial<ShopInfo>; miniApp?: string | null } = {}) {
  const calls: Call[] = [];
  const contacts: { id: number; phone: string; contactUserId: number }[] = [];
  const api: VitaloApi = {
    user: async () => {
      if (opts.user === 'down') throw new Error('API down');
      return { registered: false, blocked: false, ...(opts.user ?? {}) } as UserSummary;
    },
    staff: async () => opts.staff ?? { is_staff: false },
    info: async () => ({ support_contact: null, about_ru: 'О нас', about_uz: 'Biz haqimizda', ...opts.info }),
    saveContact: async (id, phone, contactUserId) => {
      contacts.push({ id, phone, contactUserId });
      return { saved: true };
    },
  };
  const bot = createBot({
    token: '1:TEST',
    api,
    urls: { miniApp: () => (opts.miniApp === undefined ? MINI : opts.miniApp), admin: () => ADMIN },
    botInfo: { id: 1, is_bot: true, first_name: 'VITALO', username: 'vitalo_store_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never,
  });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    return { ok: true, result: true } as never;
  });

  let updateId = 0;
  const send = async (text: string, from: { id?: number; language_code?: string } = {}) => {
    const command = text.startsWith('/') ? text.split(' ')[0].length : 0;
    const update: Update = {
      update_id: ++updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: from.id ?? 42, type: 'private', first_name: 'Ali' },
        from: { id: from.id ?? 42, is_bot: false, first_name: 'Ali', language_code: from.language_code ?? 'ru' },
        text,
        ...(command && { entities: [{ type: 'bot_command', offset: 0, length: command }] }),
      },
    };
    calls.length = 0;
    await bot.handleUpdate(update);
    return calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload);
  };
  /** The Mini App asked Telegram to share the phone: a contact message arrives in the chat. */
  const sendContact = async (phone: string, contactUserId: number) => {
    const update = {
      update_id: ++updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: 'private', first_name: 'Ali' },
        from: { id: 42, is_bot: false, first_name: 'Ali', language_code: 'ru' },
        contact: { phone_number: phone, first_name: 'Ali', user_id: contactUserId },
      },
    } as Update;
    calls.length = 0;
    await bot.handleUpdate(update);
    return calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload);
  };
  return { send, sendContact, contacts };
}

const inlineUrl = (msg: Record<string, any>) => msg.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url as string | undefined;
const keyboardTexts = (msg: Record<string, any>) => (msg.reply_markup?.keyboard as { text: string }[][]).flat().map((b) => b.text);

describe('/start and the main menu', () => {
  it('greets in Russian, shows the 6-item menu and a button that opens the Mini App', async () => {
    const [welcome, shop] = await setup().send('/start');
    expect(welcome.text).toContain('Здравствуйте, Ali!');
    expect(keyboardTexts(welcome)).toEqual(['🛍 Магазин', '📦 Мои заказы', '🔥 Акции', '👤 Мой профиль', '💬 Поддержка', 'ℹ️ О VITALO']);
    expect(inlineUrl(shop)).toBe(`${MINI}/`);
  });

  it('speaks Uzbek to Uzbek Telegram users', async () => {
    const [welcome] = await setup().send('/start', { language_code: 'uz' });
    expect(welcome.text).toContain('Assalomu alaykum');
    expect(keyboardTexts(welcome)).toContain('🛍 Do‘kon');
  });

  it('the language chosen in the shop wins over Telegram language', async () => {
    const [welcome] = await setup({ user: { registered: true, language: 'uz' } }).send('/start', { language_code: 'ru' });
    expect(welcome.text).toContain('Assalomu alaykum');
  });

  it('/start <code> passes the referral code to the Mini App as startapp', async () => {
    const [, shop] = await setup().send('/start FRIEND_42');
    expect(inlineUrl(shop)).toBe(`${MINI}/?startapp=FRIEND_42`);
  });

  it('a malformed referral code is dropped', async () => {
    const [, shop] = await setup().send('/start bad<script>');
    expect(inlineUrl(shop)).toBe(`${MINI}/`);
  });

  it('without an https Mini App address the bot says the shop is unavailable', async () => {
    const [, shop] = await setup({ miniApp: null }).send('/start');
    expect(shop.text).toContain('Магазин временно недоступен');
    expect(shop.reply_markup).toBeUndefined();
  });
});

describe('menu items', () => {
  const orders = [
    { id: 'o1', order_number: 'VTL-20261003-0002', status: 'in_transit', total_uzs: 310000, created_at: '' },
    { id: 'o3', order_number: 'VTL-20261003-0003', status: 'awaiting_payment', payment_reported: true, total_uzs: 50000, created_at: '' },
    { id: 'o2', order_number: 'VTL-20261003-0001', status: 'delivered', total_uzs: 89000, created_at: '' },
  ];

  it('Мои заказы: last orders with statuses and a button to all orders', async () => {
    const [msg] = await setup({ user: { registered: true, language: 'ru', orders } }).send('📦 Мои заказы');
    expect(msg.text).toBe(
      'Ваши последние заказы:\n• №VTL-20261003-0002 — 🚚 В пути, 310 000 сум\n• №VTL-20261003-0003 — 🔵 Оплата проверяется, 50 000 сум\n• №VTL-20261003-0001 — ✅ Доставлен, 89 000 сум',
    );
    expect(inlineUrl(msg)).toBe(`${MINI}/orders`);
  });

  it('Buyurtmalarim (Uzbek button) works the same way', async () => {
    const [msg] = await setup({ user: { registered: true, language: 'uz', orders } }).send('📦 Buyurtmalarim');
    expect(msg.text).toContain('№VTL-20261003-0002 — 🚚 Yo‘lda, 310 000 so‘m');
  });

  it('unknown users are invited to open the shop first; blocked users are told so', async () => {
    expect((await setup().send('📦 Мои заказы'))[0].text).toContain('Откройте магазин хотя бы один раз');
    expect((await setup({ user: { blocked: true } }).send('👤 Мой профиль'))[0].text).toContain('заблокирован');
  });

  it('Мой профиль: bonuses, counters, last 3 orders', async () => {
    const [msg] = await setup({
      user: { registered: true, language: 'ru', first_name: 'Ali', bonus_balance_uzs: 15000, orders_total: 7, favorites_count: 2, addresses_count: 1, orders },
    }).send('👤 Мой профиль');
    expect(msg.text).toContain('🎁 VITALO Bonus: скоро');
    expect(msg.text).not.toMatch(/Бонусы|15 000|0 сум/);
    expect(msg.text).toContain('📦 Заказов: 7');
    expect(msg.text).toContain('• №VTL-20261003-0001 — ✅ Доставлен');
    expect(inlineUrl(msg)).toBe(`${MINI}/profile`);
  });

  it('Магазин, Акции, Поддержка, О VITALO', async () => {
    const s = setup({ info: { support_contact: '@vitalo_help' } });
    expect(inlineUrl((await s.send('🛍 Магазин'))[0])).toBe(`${MINI}/`);
    expect((await s.send('🔥 Акции'))[0].text).toContain('акций нет');
    const support = (await s.send('💬 Поддержка'))[0];
    expect(support.text).toBe('Поддержка VITALO: @vitalo_help');
    expect(support.reply_markup.inline_keyboard[0][0].url).toBe('https://t.me/vitalo_help');
    expect((await s.send('ℹ️ О VITALO'))[0].text).toBe('О нас');
    // Nothing saved in the settings: the default contact, never "скоро появится".
    expect((await setup().send('💬 Поддержка'))[0].text).toBe('Поддержка VITALO: @VITALO_support');
  });

  it('a shared phone is saved only when it is the sender’s own number', async () => {
    const s = setup();
    expect((await s.sendContact('998901234567', 42))[0].text).toContain('Номер сохранён');
    expect(s.contacts).toEqual([{ id: 42, phone: '998901234567', contactUserId: 42 }]);
    expect((await s.sendContact('998907777777', 99))[0].text).toBe('Можно отправить только свой номер.');
    expect(s.contacts).toHaveLength(1);
  });

  it('when the API is down the bot answers politely instead of failing', async () => {
    const [msg] = await setup({ user: 'down' }).send('📦 Мои заказы');
    expect(msg.text).toBe('Не удалось получить данные. Попробуйте через минуту.');
  });

  it('any other text shows the menu again', async () => {
    const [msg] = await setup().send('привет');
    expect(msg.text).toContain('Выберите пункт меню');
    expect(keyboardTexts(msg)).toHaveLength(6);
  });
});

describe('/admin', () => {
  it('employees get a button that opens the admin panel inside Telegram', async () => {
    const [msg] = await setup({ staff: { is_staff: true, role: 'admin', name: 'Admin' } }).send('/admin');
    expect(msg.text).toBe('Админ-панель VITALO. Вы вошли как: администратор.');
    expect(inlineUrl(msg)).toBe(`${ADMIN}/`);
  });

  it('everybody else is refused', async () => {
    const [msg] = await setup().send('/admin');
    expect(msg.text).toBe('Эта команда доступна только сотрудникам VITALO.');
    expect(msg.reply_markup).toBeUndefined();
  });
});

describe('helpers', () => {
  it('RU and UZ texts have the same keys and placeholders', () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const [k, v] of Object.entries(TEXTS.ru)) expect(ph(TEXTS.uz[k as keyof typeof TEXTS.ru]), k).toEqual(ph(v));
  });

  it('commands are localized', () => {
    expect(commandsFor('uz').map((c) => c.description)).toEqual(['Bosh menyu', 'Buyurtmalarim', 'Profilim', 'Yordam']);
  });

  it('miniAppLink builds page URLs and keeps only valid referral codes', () => {
    expect(miniAppLink(MINI, '/orders')).toBe(`${MINI}/orders`);
    expect(miniAppLink(MINI, '/', 'A-b_9')).toBe(`${MINI}/?startapp=A-b_9`);
    expect(miniAppLink(MINI, '/', 'x y')).toBe(`${MINI}/`);
  });

  it('finds the quick-tunnel address in cloudflared output', () => {
    expect(extractTunnelUrl('2026-10-03T10:00:00Z INF |  https://quiet-river-1234.trycloudflare.com                    |')).toBe(
      'https://quiet-river-1234.trycloudflare.com',
    );
    expect(extractTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
    expect(extractTunnelUrl('see https://api.trycloudflare.com for help')).toBeNull();
  });

  it('menu button points to the Mini App', async () => {
    const calls: unknown[] = [];
    await setMenuButton({ setChatMenuButton: async (p) => void calls.push(p) as never }, MINI);
    expect(calls).toEqual([{ menu_button: { type: 'web_app', text: '🛍 VITALO', web_app: { url: `${MINI}/` } } }]);
  });
});
