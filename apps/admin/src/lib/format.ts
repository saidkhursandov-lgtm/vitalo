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
  'tariff.created': 'Добавлен тариф',
  'tariff.updated': 'Изменён тариф',
  'staff.created': 'Добавлен сотрудник',
  'staff.updated': 'Изменён сотрудник',
  'staff.sessions_revoked': 'Сессии сотрудника отозваны',
};
