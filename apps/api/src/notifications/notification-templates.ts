import { formatUzs } from '../common/tashkent';
import { VERDICT_LABELS, type Verdict } from '../compat/compat';

export type Lang = 'ru' | 'uz';

/**
 * Customer: one message per order status (3.2). «new» is sent only for cash on delivery: a card order moves to
 * «awaiting_payment» in the same second and gets «order.accepted_pay» instead. Return is handled by the staff.
 */
export const CUSTOMER_STATUS_TEMPLATES = {
  new: 'order.accepted_cod',
  awaiting_payment: 'order.accepted_pay',
  paid: 'order.paid',
  picking: 'order.picking',
  handed_to_delivery: 'order.handed_to_delivery',
  in_transit: 'order.in_transit',
  delivered: 'order.delivered',
  cancelled: 'order.cancelled',
} as const;

export type TemplateName =
  | (typeof CUSTOMER_STATUS_TEMPLATES)[keyof typeof CUSTOMER_STATUS_TEMPLATES]
  | 'staff.new_order'
  | 'staff.customer_paid'
  | 'staff.payment_check_overdue'
  | 'staff.cod_confirm_overdue'
  | 'staff.order_units_attention'
  | 'staff.yandex_new_order'
  | 'staff.yandex_attention'
  | 'staff.yandex_late_summary'
  | 'staff.finance_before_due'
  | 'staff.finance_due_day'
  | 'staff.waitlist_new'
  | 'staff.compat_request'
  | 'staff.ai_red'
  | 'staff.iherb_upload_due'
  | 'compat.answered'
  | 'order.payment_reminder'
  | 'order.cod_confirmed'
  | 'order.receipt_rejected'
  | 'order.intake_guide'
  | 'waitlist.back_in_stock'
  | 'promo.message';

export interface TemplatePayload {
  order_number: string;
  total_uzs?: number;
  reason?: string | null;
  customer?: string;
  phone?: string;
  lang?: Lang;
  /** payment deadline already formatted in Tashkent time, e.g. "04.10.2026, 14:15" */
  until?: string;
  /** Mini App page for the button under the message, e.g. "/orders/<id>/pay" */
  open_path?: string;
  /** Admin panel page for the button under a staff message, e.g. "/orders/<id>" */
  admin_path?: string;
  /** Whole hours since the customer pressed «Я оплатил(а)» */
  hours?: number;
  /** Stage 2D: «OZN-A001 × 2, OZN-A023 × 1» */
  items?: string;
  /** Stage 2D: how many orders a summary is about */
  count?: number;
  /** «14.10.2026 12:00»: the shipment deadline of a Yandex order, when Yandex gave one */
  ship_by?: string;
  /** Stage 2D: the order was created without units (not enough stock) */
  shortage?: boolean;
  /** Release 1: payment method code of the order (staff.new_order), e.g. "cod" */
  payment?: string;
  /** Stage 3 (admins only): what is not marked paid yet */
  tax_uzs?: number;
  salaries_uzs?: number;
  /** 2.4: product name for waiting-list messages */
  product?: string;
  /** 2.4: which page the button opens (text of the button); default: the order. 3.2: 'pay', 'link' */
  open_button?: 'order' | 'product' | 'pay' | 'link' | 'cart';
  /** 3.3: the order's promo code — one more line under the total */
  promo?: { code: string; discount_uzs: number; free_delivery: boolean } | null;
  /** 3.7: «Акция 11.11: −X сум» lines of the order */
  campaigns?: { title_ru: string; title_uz: string | null; amount_uzs: number }[];
  /** 3.2: «Как принимать ваш заказ» — short product name and its intake memo, in the customer's language */
  guide?: { name: string; text: string }[];
  /** 3.2: second button «Спросить специалиста» (support chat) */
  support_url?: string | null;
  /** 3.2: promo message written in the admin panel */
  title_ru?: string;
  title_uz?: string;
  text_ru?: string;
  text_uz?: string;
  /** 3.4: the compatibility request (staff message: buttons of the bot; customer: the answer) */
  compat_id?: string;
  /** 3.4: the customer's language, shown to the specialist */
  client_lang?: Lang;
  /** 3.4: the customer's comment (may hold health data — removed from the row after 90 days, D-40);
   *  3.5: in staff.new_order — «Комментарий к заказу» from the checkout */
  comment?: string | null;
  verdict?: Verdict;
  answer?: string;
  /** 3.4: a template answer in both languages — the centre shows the one the customer reads now */
  answer_ru?: string;
  answer_uz?: string;
  /** 3.4: Telegram's id of the sent staff message — its buttons are removed once somebody answers */
  tg_message_id?: number;
  /** 3.6: staff.new_order — «Открыть в Яндекс Картах» at the point the customer chose (orders without a point: none) */
  map_url?: string;
}

/** 3.6: the button under staff.new_order when the customer chose a point on the map. */
export const MAP_BUTTON: Record<Lang, string> = { ru: 'Открыть в Яндекс Картах', uz: 'Yandex Xaritada ochish' };

/** Text of the button under a message that has open_path. */
export const OPEN_BUTTON: Record<Lang, string> = { ru: 'Открыть заказ', uz: 'Buyurtmani ochish' };
/** 2.4: button under «… снова в наличии». */
export const OPEN_PRODUCT_BUTTON: Record<Lang, string> = { ru: 'Открыть товар', uz: 'Mahsulotni ochish' };
/** 3.2: button under «ожидает оплаты». */
export const PAY_BUTTON: Record<Lang, string> = { ru: 'Оплатить / Отправить чек', uz: 'To‘lash / Chek yuborish' };
/** 3.2: button under a promo message. */
export const LINK_BUTTON: Record<Lang, string> = { ru: 'Открыть', uz: 'Ochish' };
/** 3.4: button under the specialist's answer. */
export const CART_BUTTON: Record<Lang, string> = { ru: 'Открыть корзину', uz: 'Savatni ochish' };
/** 3.2: second button under «Как принимать ваш заказ». */
export const SUPPORT_BUTTON: Record<Lang, string> = { ru: 'Спросить специалиста', uz: 'Mutaxassisdan so‘rash' };

export function openButtonText(kind: TemplatePayload['open_button'], lang: Lang): string {
  if (kind === 'product') return OPEN_PRODUCT_BUTTON[lang];
  if (kind === 'pay') return PAY_BUTTON[lang];
  if (kind === 'link') return LINK_BUTTON[lang];
  if (kind === 'cart') return CART_BUTTON[lang];
  return OPEN_BUTTON[lang];
}

/** 3.2: last line of «Как принимать ваш заказ» (bot and Mini App). */
export const INTAKE_FOOTER: Record<Lang, string> = {
  ru: 'Сверяйте с этикеткой. Если принимаете лекарства — уточните у специалиста.',
  uz: 'Yorliq bilan solishtiring. Agar dori-darmon qabul qilsangiz, mutaxassisdan aniqlang.',
};
/** Telegram allows 4096 characters; long memos are cut off so the message is never rejected. */
const GUIDE_LIMIT = 3500;

function guideText(p: TemplatePayload, lang: Lang): string {
  const title = lang === 'uz' ? `№${p.order_number} buyurtmangizni qanday qabul qilish kerak` : `Как принимать ваш заказ №${p.order_number}`;
  let body = '';
  for (const g of p.guide ?? []) {
    const block = `\n\n${g.name}\n${g.text}`;
    if (body.length + block.length > GUIDE_LIMIT) break;
    body += block;
  }
  return `${title}${body}\n\n${INTAKE_FOOTER[lang]}`;
}
/** Text of the button under a staff message that has admin_path. */
export const ADMIN_BUTTON = 'Открыть в админке';

/** Stored instead of a text when the system cancelled an unpaid order; rendered in the customer's language. */
export const EXPIRED_REASON_CODE = '@expired';
/** Payme: the payment system cancelled a paid order's payment and returns the money itself. */
export const PAYME_CANCELLED_REASON_CODE = '@payme_cancelled';

function reasonLine(p: TemplatePayload, lang: Lang): string {
  if (!p.reason) return '';
  const text =
    p.reason === EXPIRED_REASON_CODE
      ? lang === 'uz'
        ? 'buyurtma belgilangan muddatda to‘lanmadi'
        : 'заказ не был оплачен вовремя'
      : p.reason === PAYME_CANCELLED_REASON_CODE
        ? lang === 'uz'
          ? 'to‘lov Payme’da bekor qilindi, pul kartangizga qaytariladi'
          : 'оплата отменена в Payme, деньги вернутся на карту'
        : p.reason;
  return lang === 'uz' ? `\nSabab: ${text}` : `\nПричина: ${text}`;
}

const sum = (n: number | undefined, lang: Lang) => `${formatUzs(n ?? 0)} ${lang === 'uz' ? 'so‘m' : 'сум'}`;

/** 3.3: a new line «Промокод VITALO10: −20 000 сум» / «…: доставка бесплатно»; empty without a code. */
/** 3.5: the customer's comment from the checkout, line breaks kept (plain-text message, up to 500 characters). */
/** 3.6: one line about the map point; the link itself is the button under the message. */
export function mapLine(p: TemplatePayload, lang: Lang): string {
  return p.map_url ? `\n📍 ${lang === 'uz' ? 'Xaritadagi nuqta: pastdagi tugma' : 'Точка на карте: кнопка «Открыть в Яндекс Картах» ниже'}` : '';
}

export function commentLine(p: TemplatePayload, lang: Lang): string {
  const text = p.comment?.trim();
  return text ? `
💬 ${lang === 'uz' ? 'Mijoz izohi' : 'Комментарий клиента'}:
${text}` : '';
}

/** The order's discounts: 3.7 «Акция 11.11: −X сум» lines, then 3.3 «Промокод VITALO10: −Y сум». */
export function promoLine(p: TemplatePayload, lang: Lang): string {
  const sales = (p.campaigns ?? []).map((c) => `\n${lang === 'uz' ? `«${c.title_uz || c.title_ru}» aksiyasi` : `Акция «${c.title_ru}»`}: −${sum(c.amount_uzs, lang)}`).join('');
  if (!p.promo) return sales;
  const what = p.promo.free_delivery ? (lang === 'uz' ? 'yetkazib berish bepul' : 'доставка бесплатно') : `−${sum(p.promo.discount_uzs, lang)}`;
  return `${sales}\n${lang === 'uz' ? 'Promokod' : 'Промокод'} ${p.promo.code}: ${what}`;
}

/** Status names shared with the Mini App order screen and the bot ("Мои заказы"). */
export const STATUS_LABELS: Record<Lang, Record<string, string>> = {
  ru: {
    new: '🕓 Ожидает подтверждения',
    confirmed: '🟢 Подтверждён',
    awaiting_payment: '🟡 Ожидает оплаты',
    checking: '🔵 Оплата проверяется',
    paid: '🟢 Оплачен',
    picking: '📦 Собирается',
    handed_to_delivery: '🚚 Передан курьеру',
    in_transit: '🚚 В пути',
    delivered: '✅ Доставлен',
    cancelled: '⚪ Отменён',
    return: '↩️ Возврат',
  },
  uz: {
    new: '🕓 Tasdiqlash kutilmoqda',
    confirmed: '🟢 Tasdiqlandi',
    awaiting_payment: '🟡 To‘lov kutilmoqda',
    checking: '🔵 To‘lov tekshirilmoqda',
    paid: '🟢 To‘langan',
    picking: '📦 Yig‘ilmoqda',
    handed_to_delivery: '🚚 Kuryerga topshirildi',
    in_transit: '🚚 Yo‘lda',
    delivered: '✅ Yetkazildi',
    cancelled: '⚪ Bekor qilindi',
    return: '↩️ Qaytarish',
  },
};

const head = (p: TemplatePayload, lang: Lang, status: string) =>
  lang === 'uz' ? `№${p.order_number} buyurtma: ${STATUS_LABELS.uz[status]}` : `Заказ №${p.order_number}: ${STATUS_LABELS.ru[status]}`;

const TEXTS: Record<TemplateName, Record<Lang, (p: TemplatePayload) => string>> = {
  'order.payment_reminder': {
    ru: (p) => `⏰ Заказ №${p.order_number} ждёт оплаты до ${p.until}.\nЕсли вы уже перевели деньги, нажмите «Я оплатил(а)».`,
    uz: (p) => `⏰ №${p.order_number} buyurtma ${p.until} gacha to‘lovni kutmoqda.\nAgar pulni allaqachon o‘tkazgan bo‘lsangiz, «To‘ladim» tugmasini bosing.`,
  },
  // 3.1: a manager rejected the receipt sent to the bot; the order waits for the payment again
  'order.receipt_rejected': {
    ru: (p) => `Чек по заказу №${p.order_number} не принят.\nПричина: ${p.reason ?? '—'}\nПроверьте перевод и пришлите чек ещё раз или напишите в поддержку.`,
    uz: (p) => `№${p.order_number} buyurtma cheki qabul qilinmadi.\nSabab: ${p.reason ?? '—'}\nO‘tkazmani tekshirib, chekni qayta yuboring yoki qo‘llab-quvvatlash xizmatiga yozing.`,
  },
  // 3.2: the order was just placed
  'order.accepted_pay': {
    ru: (p) => `Заказ №${p.order_number} принят. Ожидает оплаты: ${sum(p.total_uzs, 'ru')}${p.until ? ` до ${p.until}` : ''}. После перевода отправьте чек.${promoLine(p, 'ru')}`,
    uz: (p) => `№${p.order_number} buyurtma qabul qilindi. To‘lov kutilmoqda: ${sum(p.total_uzs, 'uz')}${p.until ? `, ${p.until} gacha` : ''}. O‘tkazmadan so‘ng chekni yuboring.${promoLine(p, 'uz')}`,
  },
  'order.accepted_cod': {
    ru: (p) => `Заказ №${p.order_number} принят. Ожидает подтверждения: менеджер позвонит вам в рабочее время (08:00–22:00).${promoLine(p, 'ru')}`,
    uz: (p) => `№${p.order_number} buyurtma qabul qilindi. Tasdiqlash kutilmoqda: menejer ish vaqtida (08:00–22:00) qo‘ng‘iroq qiladi.${promoLine(p, 'uz')}`,
  },
  'order.paid': {
    ru: (p) => `Заказ №${p.order_number}: оплата подтверждена. Скоро начнём сборку.`,
    uz: (p) => `№${p.order_number} buyurtma: to‘lov tasdiqlandi. Tez orada yig‘ishni boshlaymiz.`,
  },
  'order.cod_confirmed': {
    ru: (p) => `Заказ №${p.order_number} подтверждён. Оплата при получении: ${sum(p.total_uzs, 'ru')} наличными или переводом курьеру.${promoLine(p, 'ru')}`,
    uz: (p) => `№${p.order_number} buyurtma tasdiqlandi. Qabul qilganda to‘lash: ${sum(p.total_uzs, 'uz')} naqd yoki kuryerga o‘tkazma.${promoLine(p, 'uz')}`,
  },
  'order.picking': {
    ru: (p) => `Заказ №${p.order_number} собирается. Сообщим, когда передадим в доставку.`,
    uz: (p) => `№${p.order_number} buyurtma yig‘ilmoqda. Yetkazib berishga topshirganimizda xabar beramiz.`,
  },
  'order.intake_guide': {
    ru: (p) => guideText(p, 'ru'),
    uz: (p) => guideText(p, 'uz'),
  },
  'promo.message': {
    ru: (p) => [p.title_ru, p.text_ru].filter(Boolean).join('\n'),
    uz: (p) => [p.title_uz || p.title_ru, p.text_uz || p.text_ru].filter(Boolean).join('\n'),
  },
  'order.handed_to_delivery': {
    ru: (p) => head(p, 'ru', 'handed_to_delivery'),
    uz: (p) => head(p, 'uz', 'handed_to_delivery'),
  },
  'order.in_transit': {
    ru: (p) => head(p, 'ru', 'in_transit'),
    uz: (p) => head(p, 'uz', 'in_transit'),
  },
  'order.delivered': {
    ru: (p) => `${head(p, 'ru', 'delivered')}\nСпасибо, что выбрали VITALO!`,
    uz: (p) => `${head(p, 'uz', 'delivered')}\nVITALO’ni tanlaganingiz uchun rahmat!`,
  },
  'order.cancelled': {
    ru: (p) => `${head(p, 'ru', 'cancelled')}${reasonLine(p, 'ru')}`,
    uz: (p) => `${head(p, 'uz', 'cancelled')}${reasonLine(p, 'uz')}`,
  },
  // Staff messages: the admin panel is Russian-only, so are these.
  'staff.new_order': {
    ru: (p) =>
      `🆕 Новый заказ ${p.order_number} на ${sum(p.total_uzs, 'ru')}\nКлиент: ${p.customer ?? '—'}, ${p.phone ?? '—'}${promoLine(p, 'ru')}${commentLine(p, 'ru')}${mapLine(p, 'ru')}` +
      (p.payment === 'cod' ? '\n💵 Оплата при получении (Ташкент). Ожидает подтверждения менеджером: позвоните клиенту и подтвердите заказ в админке.' : ''),
    uz: (p) => `🆕 Yangi buyurtma ${p.order_number}: ${sum(p.total_uzs, 'uz')}\nMijoz: ${p.customer ?? '—'}, ${p.phone ?? '—'}${commentLine(p, 'uz')}${mapLine(p, 'uz')}`,
  },
  'staff.customer_paid': {
    ru: (p) => `💳 Клиент сообщил об оплате заказа ${p.order_number} на ${sum(p.total_uzs, 'ru')}.\nПроверьте поступление и подтвердите оплату в админке.`,
    uz: (p) => `💳 Mijoz ${p.order_number} buyurtmasi uchun ${sum(p.total_uzs, 'uz')} to‘laganini bildirdi.\nTushumni tekshirib, admin panelda tasdiqlang.`,
  },
  // Stage 0.2: no customer name or phone here, only the order, the amount and the waiting time.
  'staff.payment_check_overdue': {
    ru: (p) =>
      `⏳ Оплата заказа ${p.order_number} на ${sum(p.total_uzs, 'ru')} ждёт проверки уже ${p.hours ?? '?'} ч.\nКлиент нажал «Я оплатил(а)», платёж ещё не подтверждён. Заказ не отменяется, товар остаётся в резерве.`,
    uz: (p) =>
      `⏳ ${p.order_number} buyurtmasi uchun ${sum(p.total_uzs, 'uz')} to‘lov ${p.hours ?? '?'} soatdan beri tekshiruvni kutmoqda.\nMijoz «To‘ladim» tugmasini bosgan, to‘lov hali tasdiqlanmagan.`,
  },
  // Release 1 (D-18): «Оплата при получении» waits for the manager; no customer name or phone here.
  'staff.cod_confirm_overdue': {
    ru: (p) =>
      `⏳ Заказ ${p.order_number} на ${sum(p.total_uzs, 'ru')} (оплата при получении) ждёт подтверждения уже ${p.hours ?? '?'} ч.\nПозвоните клиенту и подтвердите заказ в админке. Заказ не отменяется, товар остаётся в резерве.`,
    uz: (p) =>
      `⏳ ${p.order_number} buyurtmasi (${sum(p.total_uzs, 'uz')}, qabul qilganda to‘lash) ${p.hours ?? '?'} soatdan beri tasdiqlanishini kutmoqda.\nMijozga qo‘ng‘iroq qilib, buyurtmani admin panelda tasdiqlang.`,
  },
  // Stage 2E: a paid Mini App order whose units could not be reserved. No customer data.
  'staff.order_units_attention': {
    ru: (p: TemplatePayload) => `⚠️ Заказ ${p.order_number} оплачен, но банки не закреплены: ${p.reason ?? ''}. Нужно внимание склада.`,
    uz: (p: TemplatePayload) => `⚠️ ${p.order_number}: ${p.reason ?? ''}`,
  },
  // Stage 2D: Yandex orders (staff only, Russian; order_number = the Yandex order number). No customer data.
  'staff.yandex_new_order': {
    ru: (p: TemplatePayload) =>
      `🟡 ${p.ship_by ? `Новый заказ Яндекс № ${p.order_number}, отгрузить до ${p.ship_by}` : `Новый заказ Яндекса № ${p.order_number}`}\n${p.items ?? ''}${p.shortage ? '\n⚠️ Не хватает остатка: банки не зарезервированы' : '\nБанки зарезервированы, можно собирать.'}`,
    uz: (p: TemplatePayload) => `🟡 Yandex buyurtmasi № ${p.order_number}\n${p.items ?? ''}`,
  },
  'staff.yandex_attention': {
    ru: (p: TemplatePayload) => `⚠️ Заказ Яндекса № ${p.order_number} требует внимания: ${p.reason ?? ''}`,
    uz: (p: TemplatePayload) => `⚠️ Yandex buyurtmasi № ${p.order_number}: ${p.reason ?? ''}`,
  },
  'staff.yandex_late_summary': {
    ru: (p: TemplatePayload) =>
      `ℹ️ Синхронизация Яндекса: ${p.count ?? 0} заказ(ов) впервые увидены уже отгруженными или отменёнными. Автоматически они не создаются — посмотрите «Требует внимания» и закройте неактуальные.`,
    uz: (p: TemplatePayload) => `ℹ️ Yandex: ${p.count ?? 0} ta buyurtma.`,
  },
  // 2.4: a customer pressed «Сообщить о поступлении» (staff only, Russian). order_number is not used.
  'staff.waitlist_new': {
    ru: (p: TemplatePayload) => `🔔 Лист ожидания: ${p.product ?? ''}
Ждут поступления: ${p.count ?? 0}`,
    uz: (p: TemplatePayload) => `🔔 Kutish roʻyxati: ${p.product ?? ''}
Kutmoqda: ${p.count ?? 0}`,
  },
  // 3.4: a customer asked to check the cart (admins and specialists, Russian). The buttons are added by the worker.
  'staff.compat_request': {
    ru: (p: TemplatePayload) =>
      `Проверка совместимости\nЯзык клиента: ${p.client_lang === 'uz' ? 'узбекский (UZ)' : 'русский (RU)'}\n\nСостав корзины:\n${p.items ?? ''}\n\nКомментарий: ${p.comment || '—'}`,
    uz: (p: TemplatePayload) => `Moslikni tekshirish\n${p.items ?? ''}`,
  },
  // 3.8: VITALO AI answered «Нужна консультация» (admins and specialists, Russian): check it in «Совместимость → AI-ответы».
  'staff.ai_red': {
    ru: (p: TemplatePayload) =>
      `VITALO AI: «Нужна консультация» — проверьте ответ в первую очередь\nЯзык клиента: ${p.client_lang === 'uz' ? 'узбекский (UZ)' : 'русский (RU)'}\n\nСостав корзины:\n${p.items ?? ''}\n\nАдминка → Совместимость → AI-ответы`,
    uz: (p: TemplatePayload) => `VITALO AI: «Maslahat kerak»\n${p.items ?? ''}`,
  },
  // 3.4: the specialist's answer to the customer (bot + «Заказы» of the Mini App centre).
  'compat.answered': {
    ru: (p: TemplatePayload) =>
      `Специалист VITALO ответил на запрос о совместимости\n\n${p.verdict ? VERDICT_LABELS[p.verdict].ru : ''}\n${p.answer ?? ''}\n\nНе является медицинской консультацией.`,
    uz: (p: TemplatePayload) =>
      `VITALO mutaxassisi moslik haqidagi soʻrovingizga javob berdi\n\n${p.verdict ? VERDICT_LABELS[p.verdict].uz : ''}\n${p.answer ?? ''}\n\nTibbiy maslahat hisoblanmaydi.`,
  },
  // 2.4: the product a customer waited for is available again. order_number is not used.
  'waitlist.back_in_stock': {
    ru: (p: TemplatePayload) => `${p.product ?? ''} снова в наличии`,
    uz: (p: TemplatePayload) => `${p.product ?? ''} yana sotuvda`,
  },
  // D-57: 09:00 / 15:00 / 21:00 — nobody uploaded the iHerb wishlist yet (admins, Russian; switched on in «iHerb и цены»).
  'staff.iherb_upload_due': {
    ru: (p: TemplatePayload) => `Пора загрузить вишлист iHerb: товаров со ссылкой iHerb — ${p.count ?? 0}. Сохраните страницу вишлиста и загрузите её в «iHerb и цены».`,
    uz: (p: TemplatePayload) => `iHerb istaklar roʻyxatini yuklash vaqti: ${p.count ?? 0} ta mahsulot.`,
  },
  // Stage 3: only admins get these (money). order_number is not used.
  'staff.finance_before_due': {
    ru: (p: TemplatePayload) => `🗓 14-го к оплате: налог ${sum(p.tax_uzs, 'ru')}, зарплаты ${sum(p.salaries_uzs, 'ru')}.`,
    uz: (p: TemplatePayload) => `🗓 14-kuni to‘lov: soliq ${sum(p.tax_uzs, 'uz')}, ish haqi ${sum(p.salaries_uzs, 'uz')}.`,
  },
  'staff.finance_due_day': {
    ru: (p: TemplatePayload) => `⏰ Срок оплаты — 14-е. Не отмечено оплаченным: налог ${sum(p.tax_uzs, 'ru')}, зарплаты ${sum(p.salaries_uzs, 'ru')}.`,
    uz: (p: TemplatePayload) => `⏰ To‘lov muddati — 14-kun. To‘lanmagan: soliq ${sum(p.tax_uzs, 'uz')}, ish haqi ${sum(p.salaries_uzs, 'uz')}.`,
  },
};


export function isTemplate(name: string): name is TemplateName {
  return name in TEXTS;
}

/** Final message text in the recipient's language (Russian if unknown). */
export function renderNotification(template: string, payload: TemplatePayload): string {
  if (!isTemplate(template)) throw new Error(`Unknown notification template: ${template}`);
  const lang: Lang = payload.lang === 'uz' ? 'uz' : 'ru';
  return TEXTS[template][lang](payload);
}

/** 3.2: sections of the Mini App notification centre. «bonus» is reserved for release 4 and not shown yet. */
export const CENTRE_CATEGORIES = ['order', 'waitlist', 'promo', 'compat'] as const;
export type CentreCategory = (typeof CENTRE_CATEGORIES)[number] | 'bonus';

/** Short plain lines for the centre (no emoji: the Mini App draws SVG icons). */
const CENTRE_LINES: Partial<Record<TemplateName, Record<Lang, (p: TemplatePayload) => string>>> = {
  'order.accepted_pay': { ru: () => 'Принят. Ожидает оплаты', uz: () => 'Qabul qilindi. To‘lov kutilmoqda' },
  'order.accepted_cod': { ru: () => 'Принят. Ожидает подтверждения', uz: () => 'Qabul qilindi. Tasdiqlash kutilmoqda' },
  'order.paid': { ru: () => 'Оплата подтверждена', uz: () => 'To‘lov tasdiqlandi' },
  'order.cod_confirmed': { ru: () => 'Подтверждён, оплата при получении', uz: () => 'Tasdiqlandi, qabul qilganda to‘lash' },
  'order.picking': { ru: () => 'Собирается', uz: () => 'Yig‘ilmoqda' },
  'order.handed_to_delivery': { ru: () => 'Передан курьеру', uz: () => 'Kuryerga topshirildi' },
  'order.in_transit': { ru: () => 'В пути', uz: () => 'Yo‘lda' },
  'order.delivered': { ru: () => 'Доставлен. Спасибо, что выбрали VITALO!', uz: () => 'Yetkazildi. VITALO’ni tanlaganingiz uchun rahmat!' },
  'order.cancelled': { ru: (p) => `Отменён${reasonLine(p, 'ru').replace('\n', '. ')}`, uz: (p) => `Bekor qilindi${reasonLine(p, 'uz').replace('\n', '. ')}` },
  'order.payment_reminder': { ru: (p) => `Ждёт оплаты до ${p.until}`, uz: (p) => `${p.until} gacha to‘lovni kutmoqda` },
  'order.receipt_rejected': { ru: (p) => `Чек не принят. Причина: ${p.reason ?? '—'}`, uz: (p) => `Chek qabul qilinmadi. Sabab: ${p.reason ?? '—'}` },
  'order.intake_guide': { ru: () => 'Как принимать ваш заказ', uz: () => 'Buyurtmani qanday qabul qilish kerak' },
  'waitlist.back_in_stock': { ru: () => 'Снова в наличии', uz: () => 'Yana sotuvda' },
};

/** Title and line of a centre entry in the customer's language. */
export function renderCentre(template: string, payload: TemplatePayload, lang: Lang): { title: string; body: string } {
  if (template === 'promo.message') {
    return lang === 'uz'
      ? { title: payload.title_uz || payload.title_ru || '', body: payload.text_uz || payload.text_ru || '' }
      : { title: payload.title_ru || '', body: payload.text_ru || '' };
  }
  const line = isTemplate(template) ? CENTRE_LINES[template]?.[lang](payload) : undefined;
  if (template === 'waitlist.back_in_stock') return { title: payload.product ?? '', body: line ?? '' };
  if (template === 'compat.answered') {
    const label = payload.verdict ? VERDICT_LABELS[payload.verdict][lang] : '';
    return { title: lang === 'uz' ? 'Moslikni tekshirish' : 'Проверка совместимости', body: [label, (lang === 'uz' ? payload.answer_uz : payload.answer_ru) || payload.answer].filter(Boolean).join('. ') };
  }
  return { title: lang === 'uz' ? `№${payload.order_number} buyurtma` : `Заказ №${payload.order_number}`, body: line ?? renderNotification(template, { ...payload, lang }) };
}

/** 3.2 (after the owner's check): tabs of the centre. «promo» also holds bonuses (release 4); «service» — everything else. */
export type CentreTab = 'orders' | 'promo' | 'service';
export function centreTab(category: string | null): CentreTab {
  if (category === 'order' || category === 'compat') return 'orders'; // 3.4: «заказ / консультация»
  if (category === 'promo' || category === 'bonus') return 'promo';
  return 'service';
}

/** Short step names for the order path «Принят → Оплачен → Собирается» (other order messages are not steps). */
const CENTRE_STEPS: Partial<Record<TemplateName, Record<Lang, string>>> = {
  'order.accepted_pay': { ru: 'Принят', uz: 'Qabul qilindi' },
  'order.accepted_cod': { ru: 'Принят', uz: 'Qabul qilindi' },
  'order.paid': { ru: 'Оплачен', uz: 'To‘landi' },
  'order.cod_confirmed': { ru: 'Подтверждён', uz: 'Tasdiqlandi' },
  'order.picking': { ru: 'Собирается', uz: 'Yig‘ilmoqda' },
  'order.handed_to_delivery': { ru: 'Передан курьеру', uz: 'Kuryerga topshirildi' },
  'order.in_transit': { ru: 'В пути', uz: 'Yo‘lda' },
  'order.delivered': { ru: 'Доставлен', uz: 'Yetkazildi' },
  'order.cancelled': { ru: 'Отменён', uz: 'Bekor qilindi' },
};
export function centreStep(template: string, lang: Lang): string | null {
  return isTemplate(template) ? (CENTRE_STEPS[template]?.[lang] ?? null) : null;
}
