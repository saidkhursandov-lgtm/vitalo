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

/** 3.6: «Открыть в Яндекс Картах» — a pin at the point the customer chose (same link as in the bot message). */
export function yandexMapsLink(lat: number, lon: number): string {
  return `https://yandex.uz/maps/?pt=${lon.toFixed(6)},${lat.toFixed(6)}&z=17&l=map`;
}

export function prettyPhone(phone: string): string {
  const m = phone.match(/^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/);
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : phone;
}

export const ORDER_STATUS: Record<string, string> = {
  new: 'Ожидает подтверждения',
  awaiting_payment: 'Ожидает оплаты',
  paid: 'Оплачен',
  picking: 'Собирается',
  handed_to_delivery: 'Передан курьеру',
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
  'order.receipt_rejected': 'Чек об оплате отклонён (в боте)',
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
  'settings.card_code_sent': 'Запрошен код для смены карты',
  'settings.checkout_options_updated': 'Изменены настройки оплаты (при получении, Payme / Click / Uzum, бесплатная доставка)',
  'settings.texts_updated': 'Изменены тексты магазина',
  'settings.maps_updated': 'Включена или выключена карта (Яндекс) в Mini App',
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
  'staff.login': 'Вход в админку',
  'staff.login_confirmed': 'Вход с нового устройства подтверждён в боте',
  'staff.login_denied': 'Вход отклонён в боте («Это не я»)',
  'staff.backup_code_used': 'Вход по резервному коду',
  'staff.backup_codes_created': 'Созданы резервные коды',
  'staff.session_revoked': 'Выход на одном устройстве',
  'staff.logout_everywhere': 'Выход на всех устройствах',
  'product.label_updated': 'Изменён состав для этикетки',
  'receiving.started': 'Начата приёмка',
  'receiving.accepted': 'Приняты единицы (Physical ID)',
  'receiving.completed': 'Приёмка завершена',
  'receiving.cancelled': 'Приёмка отменена',
  'receiving.opening_imported': 'Загружен начальный остаток (единицы)',
  'inventory.unit_tracking_override': 'Операция в обход учёта по единицам',
  'product.unit_tracking_started': 'Товар переведён на учёт по банкам (приёмка по закупке)',
  'product.price_auto_iherb': 'Автоцена по iHerb',
  'iherb.wishlist_uploaded': 'Загружен вишлист iHerb',
  'settings.iherb_prices_updated': 'Изменены настройки iHerb (напоминания, сигналы закупки)',
  'settings.cross_border_updated': 'Изменены сроки «из США» и гарантия',
  'cross_border.batch_created': 'Создана посылка из США',
  'cross_border.batch_items_added': 'Строки добавлены в посылку из США',
  'cross_border.batch_stage': 'Изменён этап посылки из США',
  'cross_border.batch_purchase': 'Посылке из США выбрана закупка',
  'cross_border.attached_from_stock': 'Банки со склада отданы заказу «из США»',
  'cross_border.date_moved': 'Сдвинута дата доставки «из США»',
  'settings.admin_ai_updated': 'Изменены настройки AI-аналитика',
  'ai_analyst.feed_saved': 'AI-аналитик: сохранены данные из загрузки',
  'ai_analyst.fact_added': 'AI-аналитик: записано решение или заметка',
  'ai_analyst.fact_off': 'AI-аналитик: факт убран из памяти',
  'product.unit_tracking_fix': 'Учёт по банкам включён вручную (исправление данных)',
  // аудит 10.11, п. 1.12: подписи для действий, которые раньше показывались сырыми ключами
  'banner.created': 'Добавлен баннер',
  'banner.updated': 'Изменён баннер',
  'banner.deleted': 'Удалён баннер',
  'banner.reordered': 'Изменён порядок баннеров',
  'banner.image_uploaded': 'Загружена картинка баннера',
  'banner.image_removed': 'Удалена картинка баннера',
  'brand.updated': 'Изменён бренд',
  'brand.deleted': 'Удалён бренд',
  'brand.logo_uploaded': 'Загружен логотип бренда',
  'brand.logo_removed': 'Удалён логотип бренда',
  'campaign.created': 'Создана акция',
  'campaign.updated': 'Изменена акция',
  'catalog.content_loaded': 'Загружены тексты каталога из таблицы',
  'catalog.content_rolled_back': 'Тексты каталога возвращены к прежней версии',
  'compat.answered': 'Дан ответ на вопрос о совместимости',
  'compat.saved': 'Сохранён ответ о совместимости для набора товаров',
  'compat.saved_updated': 'Изменён сохранённый ответ о совместимости',
  'compat.product_substances': 'Изменены вещества товара (совместимость)',
  'compat.substance_created': 'Добавлено вещество (совместимость)',
  'compat.substance_updated': 'Изменено вещество (совместимость)',
  'compat.rule_created': 'Добавлено правило базы знаний AI',
  'compat.rule_updated': 'Изменено правило базы знаний AI',
  'compat.rule_draft': 'Правило базы знаний AI возвращено в черновики',
  'compat.rule_approved': 'Правило базы знаний AI одобрено',
  'compat.rule_off': 'Правило базы знаний AI выключено',
  'compat.ai_new': 'Ответ VITALO AI возвращён на проверку',
  'compat.ai_approved': 'Ответ VITALO AI одобрен',
  'compat.ai_fixed': 'Ответ VITALO AI исправлен',
  'compat.ai_hidden': 'Ответ VITALO AI скрыт от покупателей',
  'competitor_price.added': 'Добавлена цена конкурента',
  'competitor_price.hidden': 'Скрыта цена конкурента',
  'dictionary.created': 'Добавлена запись справочника',
  'dictionary.backfill': 'Справочник заполнен из товаров',
  'dictionary.merged': 'Справочник: объединены дубли',
  'product.deleted': 'Товар удалён',
  'product.delete_archived': 'Товар с историей убран в архив (кнопка «Удалить»)',
  'product.sku_renamed': 'Изменён SKU товара',
  'product.yandex_price_synced': 'Цена Яндекса отмечена синхронизированной',
  'promo.sent': 'Отправлена рассылка',
  'promo_code.created': 'Создан промокод',
  'promo_code.updated': 'Изменён промокод',
  'purchase.created': 'Создана закупка',
  'server.after_transfer': 'Проверка после переезда на сервер',
  'settings.vitalo_ai_updated': 'Изменены настройки VITALO AI',
  'settings.promo_guard_updated': 'Изменена защита маржи промокодов',
  'settings.payment_timeout_updated': 'Изменён срок оплаты заказа',
  'settings.compat_templates_updated': 'Изменены шаблоны ответов о совместимости',
  'test_flag.set': 'Изменена отметка «тестовая запись»',
  'campaign.enabled': 'Акция включена',
  'campaign.disabled': 'Акция выключена',
  'promo_code.enabled': 'Промокод включён',
  'promo_code.disabled': 'Промокод выключен',
  'order.cod_confirmed': 'Заказ с оплатой при получении подтверждён',
  'order.payment_manual_override': 'Онлайн-оплата подтверждена вручную',
  'order.reserve_extended': 'Резерв заказа продлён',
  'customer.note_added': 'Заметка о клиенте',
  // аудит 2.14: who exported what
  'export.orders': 'Выгрузка заказов в Excel',
  'export.stock': 'Выгрузка остатков в Excel',
  'export.product_analytics': 'Выгрузка аналитики по товарам в Excel',
  'export.expenses': 'Выгрузка расходов в Excel',
  'support.reply': 'Ответ покупателю в обращении',
  'support.close': 'Обращение закрыто',
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

/**
 * D-53: one status text per Mini App order, the same words as in the Mini App and the bot. «Оплата при получении»
 * confirmed by the manager is «Подтверждён», not «Оплачен»: the courier takes the money at delivery.
 */
export function orderStatusLabel(status: string, cod = false): string {
  if (cod && status === 'paid') return 'Подтверждён';
  return ORDER_STATUS[status] ?? status;
}

/** System reasons of the order history are stored in English (as written by the API); the admin shows them in Russian. */
const HISTORY_REASON: Record<string, string> = {
  'Reservation expired: not paid in time': 'Истёк резерв: заказ не оплачен вовремя',
  'Cancelled by customer': 'Отменил клиент',
  'Online payment confirmed by the payment system': 'Онлайн-оплата подтверждена платёжной системой',
  'Order created': 'Заказ создан',
  'Order confirmed by the manager (cash on delivery)': 'Менеджер подтвердил заказ (оплата при получении)',
  'Bank transfer confirmed': 'Перевод подтверждён',
  'Paid order cancelled': 'Оплаченный заказ отменён',
};
/** аудит 2.3: reasons with a variable tail («Payment method: payme»): the start translated, the tail as is or as a word */
const HISTORY_PREFIX: [string, (rest: string) => string][] = [
  ['Order created. Payment method: ', (m) => `Заказ создан. Способ оплаты: ${PAYMENT_METHOD[m] ?? m}`],
  ['Payment method: ', (m) => `Способ оплаты: ${PAYMENT_METHOD[m] ?? m}`],
  ['Online payment confirmed manually: ', (why) => `Онлайн-оплата подтверждена вручную: ${why}`],
];
export function historyReason(reason: string | null): string | null {
  if (!reason) return reason;
  if (HISTORY_REASON[reason]) return HISTORY_REASON[reason];
  const prefix = HISTORY_PREFIX.find(([p]) => reason.startsWith(p));
  return prefix ? prefix[1](reason.slice(prefix[0].length)) : reason;
}

export interface CancelInfo {
  by: 'system' | 'staff' | 'customer' | 'yandex';
  reason: string | null;
  staff_name: string | null;
}

/**
 * Аудит 10.11, п. 1.6: who cancelled the order, in one short phrase — «истёк резерв» (the system, not paid in time),
 * «отменил клиент», «отменил сотрудник Имя», «отменён в Яндексе: причина».
 */
export function cancelLabel(c: CancelInfo | null | undefined): string | null {
  if (!c) return null;
  // the sync writes «Отменён в Яндексе (подстатус)»; a cancel in the admin keeps the employee's reason
  if (c.by === 'yandex') return !c.reason ? 'отменён' : /^Отменён в Яндексе/.test(c.reason) ? c.reason.replace(/^Отменён/, 'отменён') : `отменён: ${c.reason}`;
  if (c.by === 'customer') return 'отменил клиент';
  if (c.by === 'staff') return c.staff_name ? `отменил сотрудник ${c.staff_name}` : 'отменил сотрудник';
  if (c.reason?.startsWith('Reservation expired')) return 'истёк резерв';
  return 'отменён системой';
}
