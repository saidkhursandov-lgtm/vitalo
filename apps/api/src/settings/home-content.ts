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
      { ru: 'Оформите заказ — оплата при получении или переводом на карту', uz: 'Buyurtma bering — qabul qilganda yoki kartaga o‘tkazma orqali to‘lang' },
      { ru: 'Получите заказ — курьер привезёт его по адресу', uz: 'Buyurtmani oling — kuryer manzilingizga yetkazadi' },
    ],
  },
};

export const BONUS_TEASER_DEFAULT: BonusTeaser = {
  enabled: true,
  text: { ru: 'Скоро: копите бонусы за покупки и оплачивайте ими часть заказа', uz: 'Tez orada: xaridlar uchun bonus to‘plang va ular bilan buyurtmaning bir qismini to‘lang' },
};

/**
 * 2.4: «Как VITALO отбирает добавки» — an entry on Home (under «Популярное») that opens a bottom sheet.
 * 2.4 patch (after the phone check): scannable cards «Не берём / Стандарт VITALO» instead of paragraphs.
 */
export interface ManifestCard {
  title: LocalizedText;
  /** «Не берём»; empty in both languages = the line is not shown */
  bad: LocalizedText;
  /** «Стандарт VITALO» */
  good: LocalizedText;
}

export interface Manifest {
  enabled: boolean;
  title: LocalizedText;
  /** the second line of the Home entry */
  subtitle: LocalizedText;
  /** one sentence above the cards in the sheet */
  lead: LocalizedText;
  cards: ManifestCard[];
}

/**
 * Owner's texts (2.4 patch). D-36: no Halal, the capsule type as a fact; no absorption figures.
 * The Home line «3 критерия отбора» was suggested by Claude and accepted by the owner.
 */
export const MANIFEST_DEFAULT: Manifest = {
  enabled: true,
  title: { ru: 'Как VITALO отбирает добавки', uz: 'VITALO qoʻshimchalarni qanday tanlaydi' },
  subtitle: { ru: '3 критерия отбора', uz: '3 ta tanlov mezoni' },
  lead: {
    ru: 'Мы отсеиваем пустышки и проверяем каждый состав по 3 критериям:',
    uz: 'Biz foydasiz vositalarni chetlatamiz va har bir tarkibni 3 mezon boʻyicha tekshiramiz:',
  },
  cards: [
    {
      title: { ru: 'Усваиваемые формы', uz: 'Oʻzlashtiriladigan shakllar' },
      bad: { ru: 'Дешёвые оксиды и неорганические соли — плохо усваиваются', uz: 'Arzon oksidlar va noorganik tuzlar — yomon oʻzlashtiriladi' },
      good: { ru: 'Цитраты, хелаты, бисглицинаты, триглицериды', uz: 'Sitratlar, xelatlar, bisglitsinatlar, triglitseridlar' },
    },
    {
      title: { ru: 'Дозировки и кофакторы', uz: 'Dozalar va kofaktorlar' },
      bad: { ru: 'Моно-добавки без проводников усвоения', uz: 'Oʻzlashtirish yordamchilarisiz mono-qoʻshimchalar' },
      good: { ru: 'Рабочие связки: коллаген + вит. C, магний + B6, D3 + K2', uz: 'Samarali juftliklar: kollagen + C vit., magniy + B6, D3 + K2' },
    },
    {
      title: { ru: 'Оригинал и честная маркировка', uz: 'Original va ochiq belgilash' },
      bad: { ru: 'Неизвестные поставки и капсулы без маркировки', uz: 'Nomaʼlum yetkazib berish va belgilanmagan kapsulalar' },
      good: {
        ru: 'Проверенные поставки, термоконтроль на складе в Ташкенте, точная маркировка капсулы: растительная (VEGE) или животный желатин (говяжий/рыбий)',
        uz: 'Sinalgan yetkazib berish, Toshkentdagi omborda harorat nazorati, kapsulaning aniq belgilanishi: oʻsimlik (VEGE) yoki hayvon jelatini (mol/baliq)',
      },
    },
  ],
};

/** A value saved before the 2.4 patch (paragraphs, no cards) is not shown: the shop falls back to the default. */
export function manifestOrDefault(saved: unknown): Manifest {
  const m = saved as Partial<Manifest> | null;
  return m && Array.isArray(m.cards) && m.cards.length === 3 && m.lead ? (m as Manifest) : MANIFEST_DEFAULT;
}
