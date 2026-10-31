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

/** 2.4: «Как VITALO отбирает добавки» — an entry on Home (under «Популярное») that opens a bottom sheet. */
export interface Manifest {
  enabled: boolean;
  title: LocalizedText;
  subtitle: LocalizedText;
  intro: LocalizedText;
  points: { title: LocalizedText; text: LocalizedText }[];
  outro: LocalizedText;
}

/**
 * Texts from docs/content/VITALO_content.xlsx, sheet «Манифест» (point 1 without the «4–5%» figure, owner's wording).
 * D-36: no «Halal» here — the capsule type is stated as a fact until Halal is confirmed by certificates.
 */
export const MANIFEST_DEFAULT: Manifest = {
  enabled: true,
  title: { ru: 'Как VITALO отбирает добавки', uz: 'VITALO qoʻshimchalarni qanday tanlaydi' },
  subtitle: { ru: '3 правила врачебного отбора', uz: 'Shifokor tanlovining 3 qoidasi' },
  intro: {
    ru: 'Среди сотен красивых банок человеку без медицинского образования сложно отличить рабочую формулу от дешевой пустышки. Мы создали VITALO как врачебный фильтр, чтобы вы покупали только то, что действительно усваивается.',
    uz: 'Yuzlab chiroyli qadoqlar orasida tibbiy maʼlumotga ega boʻlmagan inson uchun haqiqiy ishlaydigan formulani arzon vositadan ajratish qiyin. Biz faqat organizm tomonidan toʻliq oʻzlashtiriladigan vositalarni xarid qilishingiz uchun VITALO shifokor filtrini yaratdik.',
  },
  points: [
    {
      title: { ru: 'Только биодоступные формы веществ', uz: 'Faqat yuqori oʻzlashtiriluvchan shakllar' },
      text: {
        ru: 'Мы не закупаем дешевые неорганические соли вроде оксида магния, которые усваиваются значительно хуже органических форм и вызывают дискомфорт в ЖКТ. В каталог попадают цитраты, хелаты, бисглицинаты и натуральные триглицериды.',
        uz: 'Biz organik shakllarga qaraganda ancha yomon oʻzlashtiriladigan va oshqozonda noqulaylik tugʻdiradigan magniy oksidi kabi arzon noorganik tuzlarni xarid qilmaymiz. Katalogimizga faqat sitratlar, xelatlar, bisglitsinatlar va tabiiy triglitseridlar kiritiladi.',
      },
    },
    {
      title: { ru: 'Доказанные дозировки и синергия кофакторов', uz: 'Isbotlangan dozalar va kofaktorlar uygʻunligi' },
      text: {
        ru: 'Витамины работают в связке: коллаген не синтезируется без витамина C, магний требует активного витамина B6, а высокие дозировки D3 — витамина K2 (MK-7). Мы проверяем каждый состав на правильную сочетаемость.',
        uz: 'Vitaminlar oʻzaro bogʻliqlikda ishlaydi: kollagen C vitaminisiz sintezlanmaydi, magniy B6 vitaminini, yuqori dozali D3 esa K2 (MK-7) vitaminini talab qiladi. Har bir tarkibni toʻgʻri moslik boʻyicha tekshiramiz.',
      },
    },
    {
      title: { ru: 'Оригинальность, хранение и честная маркировка', uz: 'Originallik, saqlash va ochiq belgilash' },
      text: {
        ru: 'Мы работаем только с проверенными поставками, соблюдаем температурный режим хранения на складе в Ташкенте и честно маркируем тип капсулы (растительная целлюлоза VEGE, говяжий или рыбий желатин).',
        uz: 'Biz faqat sinalgan yetkazib beruvchilar bilan ishlaymiz, Toshkentdagi omborimizda harorat rejimiga amal qilamiz va kapsula qobigʻi turini (oʻsimlik VEGE, mol yoki baliq jelatini) ochiq koʻrsatamiz.',
      },
    },
  ],
  outro: {
    ru: 'Сомневаетесь, что подойдет именно вам? Напишите нашему специалисту прямо из карточки товара — поможем собрать грамотный курс без лишних банок.',
    uz: 'Sizga aynan nima mos kelishiga ikkilanyapsizmi? Mahsulot sahifasidan mutaxassisimizga yozing — ortiqcha xarajatlarsiz toʻgʻri kursni tanlashga yordam beramiz.',
  },
};
