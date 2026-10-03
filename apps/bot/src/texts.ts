export type Lang = 'ru' | 'uz';

const ru = {
  'menu.shop': '🛍 Магазин',
  'menu.orders': '📦 Мои заказы',
  'menu.promos': '🔥 Акции',
  'menu.profile': '👤 Мой профиль',
  'menu.support': '💬 Поддержка',
  'menu.about': 'ℹ️ О VITALO',
  welcome: 'Здравствуйте, {name}! 👋\nVITALO — витамины и БАДы с доставкой по всему Узбекистану.\nВыберите пункт меню внизу экрана.',
  openShopHint: 'Каталог, корзина и заказы — в нашем магазине 👇',
  openShop: '🛍 Открыть магазин',
  shopUnavailable: 'Магазин временно недоступен. Попробуйте немного позже.',
  ordersTitle: 'Ваши последние заказы:',
  ordersEmpty: 'У вас пока нет заказов.',
  allOrders: '📋 Все заказы',
  notRegistered: 'Откройте магазин хотя бы один раз — после этого здесь появятся ваши заказы и профиль.',
  blocked: 'Ваш аккаунт заблокирован. Обратитесь в поддержку.',
  profile: '👤 {name}\n💰 Бонусы: {bonus}\n📦 Заказов: {orders}\n❤️ В избранном: {favorites}\n📍 Адресов: {addresses}',
  openProfile: '👤 Открыть профиль',
  promos: 'Сейчас акций нет — загляните позже. А пока посмотрите каталог 👇',
  support: 'Поддержка VITALO: {contact}',
  supportButton: 'Написать в поддержку',
  apiDown: 'Не удалось получить данные. Попробуйте через минуту.',
  adminOnly: 'Эта команда доступна только сотрудникам VITALO.',
  adminOpen: 'Админ-панель VITALO. Вы вошли как: {role}.',
  adminButton: '🔐 Открыть админ-панель',
  adminUnavailable: 'Адрес админ-панели не настроен (запустите туннель).',
  useMenu: 'Выберите пункт меню внизу экрана 👇',
  'cmd.start': 'Главное меню',
  'cmd.orders': 'Мои заказы',
  'cmd.profile': 'Мой профиль',
  'cmd.help': 'Поддержка',
  sum: 'сум',
  'status.new': '🟡 Ожидает оплаты',
  'status.awaiting_payment': '🟡 Ожидает оплаты',
  'status.checking': '🔵 Оплата проверяется',
  'status.paid': '🟢 Оплачен',
  'status.picking': '📦 Собирается',
  'status.handed_to_delivery': '🚚 Передан курьеру',
  'status.in_transit': '🚚 В пути',
  'status.delivered': '✅ Доставлен',
  'status.cancelled': '⚪ Отменён',
  'status.return': '↩️ Возврат',
  'role.admin': 'администратор',
  'role.manager': 'менеджер',
  'role.warehouse': 'склад',
  'role.marketer': 'маркетолог',
};

export type TextKey = keyof typeof ru;

/** Uzbek (Latin). Typed against ru: a missing translation does not compile. */
const uz: Record<TextKey, string> = {
  'menu.shop': '🛍 Do‘kon',
  'menu.orders': '📦 Buyurtmalarim',
  'menu.promos': '🔥 Aksiyalar',
  'menu.profile': '👤 Profilim',
  'menu.support': '💬 Yordam',
  'menu.about': 'ℹ️ VITALO haqida',
  welcome: 'Assalomu alaykum, {name}! 👋\nVITALO — butun O‘zbekiston bo‘ylab yetkazib beriladigan vitaminlar va qo‘shimchalar.\nEkran pastidagi menyudan tanlang.',
  openShopHint: 'Katalog, savat va buyurtmalar — do‘konimizda 👇',
  openShop: '🛍 Do‘konni ochish',
  shopUnavailable: 'Do‘kon vaqtincha ishlamayapti. Birozdan so‘ng urinib ko‘ring.',
  ordersTitle: 'So‘nggi buyurtmalaringiz:',
  ordersEmpty: 'Sizda hozircha buyurtmalar yo‘q.',
  allOrders: '📋 Barcha buyurtmalar',
  notRegistered: 'Do‘konni bir marta oching — shundan so‘ng bu yerda buyurtmalaringiz va profilingiz paydo bo‘ladi.',
  blocked: 'Hisobingiz bloklangan. Yordam xizmatiga murojaat qiling.',
  profile: '👤 {name}\n💰 Bonuslar: {bonus}\n📦 Buyurtmalar: {orders}\n❤️ Sevimlilar: {favorites}\n📍 Manzillar: {addresses}',
  openProfile: '👤 Profilni ochish',
  promos: 'Hozircha aksiyalar yo‘q — keyinroq qarab ko‘ring. Hozircha katalogni ko‘ring 👇',
  support: 'VITALO yordam xizmati: {contact}',
  supportButton: 'Yordamga yozish',
  apiDown: 'Ma’lumot olinmadi. Bir daqiqadan so‘ng urinib ko‘ring.',
  adminOnly: 'Bu buyruq faqat VITALO xodimlari uchun.',
  adminOpen: 'VITALO admin paneli. Siz kirdingiz: {role}.',
  adminButton: '🔐 Admin panelni ochish',
  adminUnavailable: 'Admin panel manzili sozlanmagan (tunnelni ishga tushiring).',
  useMenu: 'Ekran pastidagi menyudan tanlang 👇',
  'cmd.start': 'Bosh menyu',
  'cmd.orders': 'Buyurtmalarim',
  'cmd.profile': 'Profilim',
  'cmd.help': 'Yordam',
  sum: 'so‘m',
  'status.new': '🟡 To‘lov kutilmoqda',
  'status.awaiting_payment': '🟡 To‘lov kutilmoqda',
  'status.checking': '🔵 To‘lov tekshirilmoqda',
  'status.paid': '🟢 To‘langan',
  'status.picking': '📦 Yig‘ilmoqda',
  'status.handed_to_delivery': '🚚 Kuryerga topshirildi',
  'status.in_transit': '🚚 Yo‘lda',
  'status.delivered': '✅ Yetkazildi',
  'status.cancelled': '⚪ Bekor qilindi',
  'status.return': '↩️ Qaytarish',
  'role.admin': 'administrator',
  'role.manager': 'menejer',
  'role.warehouse': 'ombor',
  'role.marketer': 'marketolog',
};

export const TEXTS: Record<Lang, Record<TextKey, string>> = { ru, uz };

export function t(lang: Lang, key: TextKey, params: Record<string, string | number> = {}): string {
  let s = TEXTS[lang][key] ?? ru[key];
  for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Both languages, e.g. to recognize a menu button whatever language the keyboard was sent in. */
export const bothLangs = (key: TextKey) => [ru[key], uz[key]];

export function money(amount: number, lang: Lang): string {
  return `${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ${t(lang, 'sum')}`;
}

export const langFromTelegram = (code?: string): Lang => (code?.toLowerCase().startsWith('uz') ? 'uz' : 'ru');
