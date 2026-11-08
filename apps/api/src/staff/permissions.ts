import type { StaffRole } from '@prisma/client';

/**
 * Who may do what in the admin panel (Master TZ §18). The server checks these on every request;
 * the admin UI only uses them to hide what the employee cannot do anyway.
 * - admin: everything (implicit, not listed below);
 * - manager: orders, payments, delivery, customers;
 * - warehouse: stock, picking (Paid -> Picking -> Handed to delivery);
 * - marketer: read-only catalog and dashboard funnel (promotions/newsletters come in later stages).
 * Money that is not for everyone: purchase cost (costs.view, admin only) and revenue (dashboard.revenue).
 * Stage 2B: receiving and units for admin, manager, warehouse — without unit costs, purchase prices and Ozon order numbers.
 * Stage 2C: Yandex orders and the unit life cycle — warehouse and admin; manager only views the orders (no money),
 * marketer: no access;
 * write-off and correction of a unit, commission, prices and profit — admin only.
 */
export const PERMISSIONS = {
  'dashboard.view': ['manager', 'marketer'],
  'orders.view': ['manager', 'warehouse'],
  'orders.payment': ['manager'],
  'orders.fulfil': ['manager', 'warehouse'], // Paid -> Picking -> Handed to delivery
  'orders.deliver': ['manager'], // Handed to delivery -> In transit -> Delivered
  'orders.cancel': ['manager'],
  'orders.edit': ['manager'],
  'products.view': ['manager', 'warehouse', 'marketer'],
  'products.edit': [],
  // D-53: names, short names and descriptions, search words, categories and photos — not prices, costs, SKU, status,
  // label facts (composition, Halal) or the doctor's verdict
  'products.content': ['marketer'],
  // D-53 (D-22): home banners, home texts, manifest, «Как заказать», cart upsell and bonus teaser
  'marketing.content': ['marketer'],
  'inventory.view': ['manager', 'warehouse'],
  'inventory.edit': ['warehouse'],
  'customers.view': ['manager'],
  'customers.block': ['manager'],
  'settings.manage': [],
  'staff.manage': [],
  'audit.view': [],
  'costs.view': [], // cost price and purchase price: GET /staff/products/:id, receipt cost_uzs
  'dashboard.revenue': ['manager'], // revenue, average check and revenue per product on the dashboard
  'settings.dictionaries': [], // add / rename / archive brands, manufacturers, countries, forms
  'units.start_tracking': [], // S2B-10: «Включить учёт по банкам» in «Сверка» — admin only
  'catalog.delete': [], // D-54: «Удалить» a product or a brand (erases it; with history — archived and hidden) — admin only
  'yandex.price.view': ['manager', 'marketer'], // Yandex Market price and its sync status (not warehouse)
  'yandex.price.sync': ['manager'], // «Отметить синхронизированной»
  'purchases.view': ['manager'], // Stage 2A: list and cards of purchases (quantities only)
  'purchases.manage': [], // create, edit, Ozon cancellation
  'purchases.view_costs': [], // unit prices, totals, final actual total, allocated costs; unit cost and purchase of a unit
  'receiving.perform': ['manager', 'warehouse'], // Stage 2B: «Приёмка» by purchase (no prices, no Ozon order numbers)
  'units.view': ['manager', 'warehouse'], // Stage 2B: «Единицы», «Сверка», label printing
  'receiving.opening': [], // opening balance: complete / cancel its session (the import itself is a CLI script)
  'inventory.unit_override': [], // old quantity operations on a unit-tracked product (with a reason)
  'products.label': ['manager'], // short composition RU/UZ for the label
  'orders.waybill': ['warehouse'], // waybill number of the delivery service on a Mini App order (printed on its label)
  'orders.units': ['warehouse'], // Stage 2E: assembly of a Mini App order (pick / reserve units), return after the handover
  'yandex.orders.view': ['manager', 'warehouse'], // Stage 2C: list and card of Yandex orders (money only with yandex.orders.money)
  'yandex.orders': ['warehouse'], // Stage 2C: create, pick units, assembled, handed over, delivered, cancel / return
  'yandex.orders.money': [], // commission %, sale prices after creation, unit costs and profit of a Yandex order
  'units.missing': ['warehouse'], // «Потеряна» and «Найдена»
  'units.return_decision': ['warehouse'], // a returned unit: back on stock or written off
  'units.writeoff': [], // write-off of a unit (На складе / Возврат на проверке / Потеряна)
  'units.correct': [], // correction of the expiry date or the status (obvious mistake)
  'products.aliases': [], // add / remove alternative SKUs of a product (old codes for the Yandex sync)
  'finance.manage': [], // Stage 3: expenses, tax, payroll, analytics, test flag and own delivery cost of an order — admin only
  'yandex.sync': [],
  'promo.view': ['manager', 'marketer'], // 3.3: «Промокоды» — the table and stats (D-39 Б: the manager only looks)
  'promo.manage': ['marketer'], // 3.3: create / change / switch off promo codes
  'compat.view': ['manager'], // 3.4: «Совместимость» — requests and answers, without the customer's comment (D-40)
  'compat.answer': [], // 3.4: answer, saved combinations, templates; also any employee marked «специалист»
  'compat.rules.approve': [], // 3.8: approve a compatibility rule — VITALO AI sees approved rules only (D-45); admin only, not «специалист»
  'promo.send': ['marketer'], // 3.2: «Акции» — a promo to customers with «Получать акции и новости» (bot + Mini App centre) // Stage 2D: «Синхронизация Яндекса», «Проверить сейчас», «Требует внимания», «Закрыть как неактуальный»
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

/** 3.4: what the «специалист» mark adds to any role (it may read the customer's comment — D-40). */
export const SPECIALIST_PERMISSIONS: readonly Permission[] = ['compat.view', 'compat.answer'];

export function can(role: StaffRole, permission: Permission, specialist = false): boolean {
  return role === 'admin' || (PERMISSIONS[permission] as readonly StaffRole[]).includes(role) || (specialist && SPECIALIST_PERMISSIONS.includes(permission));
}

export function permissionsOf(role: StaffRole, specialist = false): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p, specialist));
}
