import type { LocalizedText } from './settings.service';

/** Home page (B1): banner, trust tiles, "how to order". Edited in the admin panel (Настройки → Главная). */
export interface HomeContent {
  banner: { enabled: boolean; title: LocalizedText; subtitle: LocalizedText; button: LocalizedText };
  /** {delivery} -> delivery terms from the tariffs, {from}/{to} -> payment check hours. */
  trust: { key: 'original' | 'delivery' | 'documents' | 'payments'; enabled: boolean; title: LocalizedText; text: LocalizedText }[];
  steps: { enabled: boolean; items: LocalizedText[] };
}

/** Profile card "VITALO Bonus — скоро" (B4). Interface only: no balance, no accruals. */
export interface BonusTeaser {
  enabled: boolean;
  text: LocalizedText;
}

/** Same values as migration 20261004200000 ("add if missing"). */
export const HOME_CONTENT_DEFAULT: HomeContent = {
  banner: {
    enabled: true,
    title: { ru: 'Витамины и БАДы с доставкой по Узбекистану', uz: 'O‘zbekiston bo‘ylab yetkazib beriladigan vitaminlar va BFQlar' },
    subtitle: { ru: 'Оригинальная продукция, понятные условия и поддержка в Telegram', uz: 'Original mahsulotlar, tushunarli shartlar va Telegramda yordam' },
    button: { ru: 'Смотреть каталог', uz: 'Katalogni ko‘rish' },
  },
  trust: [
    { key: 'original', enabled: true, title: { ru: 'Оригинальная продукция', uz: 'Original mahsulotlar' }, text: { ru: 'Только от проверенных производителей', uz: 'Faqat ishonchli ishlab chiqaruvchilardan' } },
    { key: 'delivery', enabled: true, title: { ru: 'Доставка по всему Узбекистану', uz: 'Butun O‘zbekiston bo‘ylab yetkazib berish' }, text: { ru: '{delivery}', uz: '{delivery}' } },
    // Off until products really have documents attached (switch on in Настройки → Главная).
    { key: 'documents', enabled: false, title: { ru: 'Документы на каждый товар', uz: 'Har bir mahsulotga hujjatlar' }, text: { ru: 'Состав и документы в карточке товара', uz: 'Tarkib va hujjatlar mahsulot sahifasida' } },
    {
      key: 'payments',
      enabled: true,
      title: { ru: 'Подтверждаем платежи ежедневно {from}-{to}', uz: 'To‘lovlarni har kuni {from}-{to} tasdiqlaymiz' },
      text: { ru: 'Перевод на карту или по реквизитам', uz: 'Kartaga yoki rekvizitlar bo‘yicha o‘tkazma' },
    },
  ],
  steps: {
    enabled: true,
    items: [
      { ru: 'Выберите товары и добавьте их в корзину', uz: 'Mahsulotlarni tanlang va savatga qo‘shing' },
      { ru: 'Оплатите удобно: переводом на карту или наличными при получении (Ташкент)', uz: 'Qulay to‘lang: kartaga o‘tkazma yoki qabul qilganda naqd pul bilan (faqat Toshkent)' },
      { ru: 'Получите заказ — курьер привезёт его по адресу', uz: 'Buyurtmani oling — kuryer manzilingizga yetkazadi' },
    ],
  },
};

export const BONUS_TEASER_DEFAULT: BonusTeaser = {
  enabled: true,
  text: { ru: 'Скоро: копите бонусы за покупки и оплачивайте ими часть заказа', uz: 'Tez orada: xaridlar uchun bonus to‘plang va ular bilan buyurtmaning bir qismini to‘lang' },
};
