import { formatUzs } from '../common/tashkent';

export type Lang = 'ru' | 'uz';

/** Customer: order status changes that are worth a message (Picking is internal, not sent). */
export const CUSTOMER_STATUS_TEMPLATES = {
  paid: 'order.paid',
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
  | 'order.payment_reminder'
  | 'order.cod_confirmed'
  | 'order.receipt_rejected'
  | 'waitlist.back_in_stock';

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
  /** 2.4: which page the button opens (text of the button); default: the order */
  open_button?: 'order' | 'product';
}

/** Text of the button under a message that has open_path. */
export const OPEN_BUTTON: Record<Lang, string> = { ru: 'Открыть заказ', uz: 'Buyurtmani ochish' };
/** 2.4: button under «… снова в наличии». */
export const OPEN_PRODUCT_BUTTON: Record<Lang, string> = { ru: 'Открыть товар', uz: 'Mahsulotni ochish' };
/** Text of the button under a staff message that has admin_path. */
export const ADMIN_BUTTON = 'Открыть в админке';

/** Stored instead of a text when the system cancelled an unpaid order; rendered in the customer's language. */
export const EXPIRED_REASON_CODE = '@expired';

function reasonLine(p: TemplatePayload, lang: Lang): string {
  if (!p.reason) return '';
  const text =
    p.reason === EXPIRED_REASON_CODE
      ? lang === 'uz'
        ? 'buyurtma belgilangan muddatda to‘lanmadi'
        : 'заказ не был оплачен вовремя'
      : p.reason;
  return lang === 'uz' ? `\nSabab: ${text}` : `\nПричина: ${text}`;
}

const sum = (n: number | undefined, lang: Lang) => `${formatUzs(n ?? 0)} ${lang === 'uz' ? 'so‘m' : 'сум'}`;

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
  'order.paid': {
    ru: (p) => `${head(p, 'ru', 'paid')}\nНачинаем собирать ваш заказ.`,
    uz: (p) => `${head(p, 'uz', 'paid')}\nBuyurtmangizni yig‘ishni boshladik.`,
  },
  'order.cod_confirmed': {
    ru: (p) => `${head(p, 'ru', 'confirmed')}\nНачинаем собирать ваш заказ. Оплата при получении: ${sum(p.total_uzs, 'ru')} наличными или переводом курьеру.`,
    uz: (p) => `${head(p, 'uz', 'confirmed')}\nBuyurtmangizni yig‘ishni boshladik. Qabul qilganda to‘lash: ${sum(p.total_uzs, 'uz')} naqd yoki kuryerga o‘tkazma.`,
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
      `🆕 Новый заказ ${p.order_number} на ${sum(p.total_uzs, 'ru')}\nКлиент: ${p.customer ?? '—'}, ${p.phone ?? '—'}` +
      (p.payment === 'cod' ? '\n💵 Оплата при получении (Ташкент). Ожидает подтверждения менеджером: позвоните клиенту и подтвердите заказ в админке.' : ''),
    uz: (p) => `🆕 Yangi buyurtma ${p.order_number}: ${sum(p.total_uzs, 'uz')}\nMijoz: ${p.customer ?? '—'}, ${p.phone ?? '—'}`,
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
  // 2.4: the product a customer waited for is available again. order_number is not used.
  'waitlist.back_in_stock': {
    ru: (p: TemplatePayload) => `${p.product ?? ''} снова в наличии`,
    uz: (p: TemplatePayload) => `${p.product ?? ''} yana sotuvda`,
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
