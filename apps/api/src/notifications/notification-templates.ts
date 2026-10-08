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
  | 'staff.yandex_new_order'
  | 'staff.yandex_attention'
  | 'staff.yandex_late_summary'
  | 'order.payment_reminder';

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
  /** Stage 2D: the order was created without units (not enough stock) */
  shortage?: boolean;
}

/** Text of the button under a message that has open_path. */
export const OPEN_BUTTON: Record<Lang, string> = { ru: 'Открыть заказ', uz: 'Buyurtmani ochish' };
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
  'order.paid': {
    ru: (p) => `${head(p, 'ru', 'paid')}\nНачинаем собирать ваш заказ.`,
    uz: (p) => `${head(p, 'uz', 'paid')}\nBuyurtmangizni yig‘ishni boshladik.`,
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
    ru: (p) => `🆕 Новый заказ ${p.order_number} на ${sum(p.total_uzs, 'ru')}\nКлиент: ${p.customer ?? '—'}, ${p.phone ?? '—'}`,
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
  // Stage 2D: Yandex orders (staff only, Russian; order_number = the Yandex order number). No customer data.
  'staff.yandex_new_order': {
    ru: (p: TemplatePayload) =>
      `🟡 Новый заказ Яндекса № ${p.order_number}\n${p.items ?? ''}${p.shortage ? '\n⚠️ Не хватает остатка: банки не зарезервированы' : '\nБанки зарезервированы, можно собирать.'}`,
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
