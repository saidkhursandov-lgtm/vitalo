const NBSP = ' ';

export function money(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return `${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)}${NBSP}сум`;
}

/** Stored in UTC, always shown in Tashkent time. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Tashkent',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function prettyPhone(phone: string): string {
  const m = phone.match(/^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/);
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : phone;
}

export const ORDER_STATUS: Record<string, string> = {
  new: 'Новый',
  awaiting_payment: 'Ожидает оплаты',
  paid: 'Оплачен',
  picking: 'Сборка',
  handed_to_delivery: 'Передан в доставку',
  in_transit: 'В пути',
  delivered: 'Доставлен',
  cancelled: 'Отменён',
  return: 'Возврат',
};

export const PAYMENT_STATUS: Record<string, string> = {
  payment_pending: 'Ожидает',
  payment_success: 'Оплачено',
  payment_failed: 'Ошибка',
  payment_cancelled: 'Отменено',
};

export const ROLE: Record<string, string> = {
  admin: 'Администратор',
  manager: 'Менеджер',
  warehouse: 'Склад',
  marketer: 'Маркетолог',
};

export const PRODUCT_STATUS: Record<string, string> = { active: 'Активен', hidden: 'Скрыт', archived: 'В архиве' };

export const MOVEMENT: Record<string, string> = {
  receipt: 'Приход',
  reserve: 'Резерв',
  release: 'Снятие резерва',
  deduct: 'Списание по заказу',
  writeoff: 'Списание',
  return_to_stock: 'Возврат на склад',
  adjustment: 'Корректировка',
};

export const CONDITION: Record<string, string> = {
  resellable: 'Годен к продаже',
  damaged: 'Повреждён',
  opened: 'Вскрыт',
  other: 'Другое',
};

/** Human names for audit actions; unknown actions are shown as is. */
export const AUDIT_ACTION: Record<string, string> = {
  'order.label_printed': 'Напечатана наклейка заказа',
  'order.waybill_changed': 'Изменён номер накладной службы доставки',
  'order.marked_test': 'Заказ помечен тестовым',
  'order.unmarked_test': 'Снята пометка «тест»',
  'order.own_delivery_cost_changed': 'Изменены наши расходы на доставку',
  'finance.expense_added': 'Добавлен расход',
  'finance.expense_changed': 'Изменён расход',
  'finance.expense_deleted': 'Удалён расход',
  'finance.category_added': 'Добавлена категория расходов',
  'finance.category_changed': 'Изменена категория расходов',
  'finance.category_deleted': 'Удалена категория расходов',
  'finance.tax_rate_changed': 'Изменена ставка налога',
  'finance.tax_paid': 'Налог отмечен оплаченным',
  'finance.employee_added': 'Добавлен сотрудник (зарплаты)',
  'finance.employee_changed': 'Изменён сотрудник (зарплаты)',
  'finance.salary_paid': 'Зарплата отмечена выплаченной',
  'order.unit_picked': 'Банка собрана в заказ',
  'order.unit_replaced': 'Банка заменена при сборке заказа',
  'order.units_reserved': 'Зарезервированы банки заказа',
  'order.units_attached': 'Старому заказу закреплены банки',
  'order.returned': 'Оформлен возврат заказа',
  'yandex_order.created': 'Создан заказ Яндекса (банки зарезервированы)',
  'yandex_order.updated': 'Изменён заказ Яндекса',
  'yandex_order.picked': 'Банка собрана в заказ Яндекса',
  'yandex_order.unit_replaced': 'Банка заменена при сборке',
  'yandex_order.status': 'Статус заказа Яндекса',
  'yandex_order.reserved': 'Зарезервированы банки заказа Яндекса',
  'yandex_sync.closed': 'Заказ Яндекса закрыт как неактуальный',
  'product.alias_added': 'Добавлен альтернативный SKU',
  'product.alias_removed': 'Удалён альтернативный SKU',
  'unit.missing': 'Банка отмечена потерянной',
  'unit.found': 'Банка найдена',
  'unit.written_off': 'Банка списана',
  'unit.return_accepted': 'Возврат принят на склад',
  'unit.return_written_off': 'Возврат списан',
  'unit.corrected': 'Корректировка банки',
  'order.bank_transfer_confirmed': 'Подтверждена оплата',
  'order.status_changed': 'Изменён статус заказа',
  'order.cancelled': 'Заказ отменён',
  'order.edited': 'Заказ изменён',
  'product.created': 'Товар создан',
  'product.updated': 'Товар изменён',
  'product.archived': 'Товар в архиве',
  'product.photo_added': 'Добавлено фото',
  'product.photo_main': 'Выбрано главное фото',
  'product.photo_removed': 'Удалено фото',
  'inventory.receipt': 'Приход',
  'inventory.writeoff': 'Списание',
  'inventory.adjustment': 'Корректировка',
  'inventory.return_to_stock': 'Возврат на склад',
  'customer.blocked': 'Клиент заблокирован',
  'customer.unblocked': 'Клиент разблокирован',
  'settings.bank_transfer_updated': 'Изменены реквизиты',
  'settings.card_transfer_updated': 'Изменены данные карты',
  'settings.checkout_options_updated': 'Изменены настройки оплаты (при получении, Payme / Click / Uzum, бесплатная доставка)',
  'settings.texts_updated': 'Изменены тексты магазина',
  'settings.contacts_updated': 'Изменены контакты и часы',
  'settings.label_size_updated': 'Изменён размер этикетки',
  'settings.home_updated': 'Изменена главная страница',
  'city.created': 'Добавлен город',
  'city.updated': 'Изменён город',
  'legal.draft_created': 'Создан черновик документа',
  'legal.draft_updated': 'Изменён черновик документа',
  'legal.published': 'Опубликован документ',
  'tariff.created': 'Добавлен тариф',
  'tariff.updated': 'Изменён тариф',
  'staff.created': 'Добавлен сотрудник',
  'staff.updated': 'Изменён сотрудник',
  'staff.sessions_revoked': 'Сессии сотрудника отозваны',
  'product.label_updated': 'Изменён состав для этикетки',
  'receiving.started': 'Начата приёмка',
  'receiving.accepted': 'Приняты единицы (Physical ID)',
  'receiving.completed': 'Приёмка завершена',
  'receiving.cancelled': 'Приёмка отменена',
  'receiving.opening_imported': 'Загружен начальный остаток (единицы)',
  'inventory.unit_tracking_override': 'Операция в обход учёта по единицам',
};

/** D-09: the shop shows a crossed-out price and a percent only up to this discount. */
export const MAX_SHOWN_DISCOUNT = 25;

/** Discount in percent when it is above the limit (the shop will not show it), otherwise null. */
export function discountAboveLimit(price: number | undefined, oldPrice: number | undefined): number | null {
  if (!price || !oldPrice || oldPrice <= price) return null;
  const pct = Math.round((1 - price / oldPrice) * 100);
  return pct > MAX_SHOWN_DISCOUNT ? pct : null;
}

export const PAYMENT_METHOD: Record<string, string> = {
  card_transfer: 'Перевод на карту',
  bank_transfer: 'Перевод по реквизитам',
  cod: 'При получении',
  payme: 'Payme',
  click: 'Click',
  uzum: 'Uzum',
};

/** Stage 2B: statuses of a physical unit. */
export const UNIT_STATUS: Record<string, string> = {
  RECEIVED: 'Принята (не завершена)',
  IN_STOCK: 'На складе',
  ASSIGNED: 'Зарезервирована',
  YANDEX_DELIVERY: 'В доставке (Яндекс)',
  YANDEX_SOLD: 'Продана (Яндекс)',
  VITALO_DELIVERY: 'В доставке (VITALO)',
  VITALO_SOLD: 'Продана (VITALO)',
  RETURNED: 'Возврат на проверке',
  MISSING: 'Потеряна',
  WRITTEN_OFF: 'Списана',
  VOIDED: 'Отменена',
};

export const UNIT_EVENT: Record<string, string> = {
  CREATED: 'Создана (Physical ID)',
  IN_STOCK: 'Поставлена на склад',
  LABEL_PRINTED: 'Напечатана этикетка',
  VOIDED: 'Отменена',
  COST_CHANGED: 'Пересчитана себестоимость',
  ASSIGNED: 'Зарезервирована под заказ',
  PICKED: 'Собрана в заказ',
  RELEASED: 'Снята с заказа, на склад',
  HANDED_TO_DELIVERY: 'Передана в доставку',
  SOLD: 'Продана (доставлена)',
  RETURNED: 'Возврат: ждёт проверки',
  RETURN_ACCEPTED: 'Возврат принят на склад',
  RETURN_WRITTEN_OFF: 'Возврат списан',
  MISSING: 'Отмечена потерянной',
  FOUND: 'Найдена, на складе',
  WRITTEN_OFF: 'Списана',
  STATUS_CORRECTED: 'Корректировка статуса',
  EXPIRY_CORRECTED: 'Корректировка срока годности',
};

/** Stage 2C: Yandex order statuses. */
export const YANDEX_STATUS: Record<string, [string, 'neutral' | 'ok' | 'warn' | 'bad' | 'info']> = {
  NEW: ['Новый', 'warn'],
  ASSEMBLED: ['Собран', 'info'],
  HANDED_TO_DELIVERY: ['Передан в доставку', 'info'],
  DELIVERED: ['Доставлен', 'ok'],
  CANCELLED: ['Отменён', 'neutral'],
  RETURNED: ['Возврат', 'bad'],
};

/** «2027-12-31» -> «31.12.2027» (expiry dates are typed and shown like this). */
export const ruDate = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '—');
