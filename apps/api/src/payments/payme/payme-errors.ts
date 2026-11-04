/** Payme Merchant API error codes (JSON-RPC 2.0). The answer is always HTTP 200 with `error`. */
export const PAYME_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  unauthorized: -32504,
  internal: -32400,
  wrongAmount: -31001,
  txNotFound: -31003,
  cannotCancel: -31007,
  cannotPerform: -31008,
  // -31050…-31099: problems with the account (our order); `data` names the field — order_id
  orderNotFound: -31050,
  orderNotPayable: -31051,
  orderBusy: -31052,
  orderNoFiscal: -31053,
} as const;

export interface PaymeMessage {
  ru: string;
  uz: string;
  en: string;
}

/** A Payme answer with an error; thrown inside the methods and turned into `error` by PaymeService.handle. */
export class PaymeError extends Error {
  constructor(
    readonly code: number,
    readonly text: PaymeMessage,
    readonly data?: string,
  ) {
    super(text.en);
  }
}

const m = (ru: string, uz: string, en: string): PaymeMessage => ({ ru, uz, en });

export const paymeErrors = {
  unauthorized: () => new PaymeError(PAYME_ERRORS.unauthorized, m('Недостаточно привилегий', 'Ruxsat yetarli emas', 'Insufficient privileges')),
  invalidRequest: (field?: string) => new PaymeError(PAYME_ERRORS.invalidRequest, m('Неверный запрос', 'Noto‘g‘ri so‘rov', 'Invalid request'), field),
  methodNotFound: (method: string) => new PaymeError(PAYME_ERRORS.methodNotFound, m('Метод не найден', 'Metod topilmadi', 'Method not found'), method),
  wrongAmount: () => new PaymeError(PAYME_ERRORS.wrongAmount, m('Неверная сумма', 'Noto‘g‘ri summa', 'Wrong amount'), 'amount'),
  txNotFound: () => new PaymeError(PAYME_ERRORS.txNotFound, m('Транзакция не найдена', 'Tranzaksiya topilmadi', 'Transaction not found'), 'id'),
  cannotPerform: () =>
    new PaymeError(PAYME_ERRORS.cannotPerform, m('Невозможно выполнить операцию', 'Amalni bajarib bo‘lmaydi', 'Unable to perform operation')),
  cannotCancel: () =>
    new PaymeError(
      PAYME_ERRORS.cannotCancel,
      m('Заказ уже передан в доставку, отменить оплату нельзя', 'Buyurtma yetkazib berishga topshirilgan, to‘lovni bekor qilib bo‘lmaydi', 'The order is already shipped; the payment cannot be cancelled'),
    ),
  orderNotFound: () => new PaymeError(PAYME_ERRORS.orderNotFound, m('Заказ не найден', 'Buyurtma topilmadi', 'Order not found'), 'order_id'),
  orderNotPayable: () =>
    new PaymeError(
      PAYME_ERRORS.orderNotPayable,
      m('Заказ уже оплачен, отменён или время оплаты истекло', 'Buyurtma to‘langan, bekor qilingan yoki to‘lov muddati tugagan', 'The order is paid, cancelled or its payment time is over'),
      'order_id',
    ),
  orderBusy: () =>
    new PaymeError(
      PAYME_ERRORS.orderBusy,
      m('Заказ ожидает оплаты по другой транзакции', 'Buyurtma boshqa tranzaksiya bo‘yicha to‘lovni kutmoqda', 'The order is waiting for another transaction'),
      'order_id',
    ),
  orderNoFiscal: () =>
    new PaymeError(
      PAYME_ERRORS.orderNoFiscal,
      m('Для чека не хватает кода ИКПУ у товара заказа', 'Chek uchun buyurtmadagi mahsulotning MXIK kodi yetishmaydi', 'A product of the order has no IKPU code for the receipt'),
      'order_id',
    ),
};
