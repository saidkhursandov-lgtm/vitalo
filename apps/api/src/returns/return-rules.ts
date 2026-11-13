/**
 * 3.10-В «Возврат по заявке покупателя» (D-71). Until the lawyer answers about returning a dietary supplement of proper
 * quality, the customer may choose only a damaged item or a wrong item (the shop's fault); the other reasons of the
 * ReturnReason enum stay for later.
 */
export const RETURN_REASONS_OPEN = ['damaged', 'wrong_item'] as const;
export type OpenReturnReason = (typeof RETURN_REASONS_OPEN)[number];

/** Days after the delivery when the request may be sent (the setting may come after the lawyer's answer). */
export const RETURN_DAYS = 14;
export const RETURN_PHOTOS_MIN = 1;
export const RETURN_PHOTOS_MAX = 3;
export const RETURN_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const RETURN_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const RETURN_COMMENT_MAX = 1000;

export const RETURN_REFUND_METHODS = ['card', 'cash', 'payme', 'click', 'other'] as const;
export type RefundMethod = (typeof RETURN_REFUND_METHODS)[number];

export const RETURN_REASON_TEXT: Record<string, { ru: string; uz: string }> = {
  damaged: { ru: 'Товар повреждён', uz: 'Mahsulot shikastlangan' },
  wrong_item: { ru: 'Привезли не тот товар', uz: 'Boshqa mahsulot keltirildi' },
  not_as_described: { ru: 'Не соответствует описанию', uz: 'Tavsifga mos emas' },
  unsuitable: { ru: 'Не подошёл', uz: 'Mos kelmadi' },
  changed_mind: { ru: 'Передумал', uz: 'Fikrimni o‘zgartirdim' },
  other: { ru: 'Другое', uz: 'Boshqa' },
};

/** The paid price of `qty` jars of a line (the line's paid total shared by its quantity). */
export const lineShare = (paidLineTotal: number, lineQty: number, qty: number): number => (lineQty > 0 ? Math.round((paidLineTotal * qty) / lineQty) : 0);

/** A part of the bonuses for a part of the order: by the share of the paid goods returned. */
export const bonusShare = (amount: number, returnedGoods: number, paidGoods: number): number =>
  paidGoods > 0 && amount > 0 ? Math.min(amount, Math.round((amount * returnedGoods) / paidGoods)) : 0;
