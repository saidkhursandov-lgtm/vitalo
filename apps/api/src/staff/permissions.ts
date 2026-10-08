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
  'yandex.orders.view': ['manager', 'warehouse'], // Stage 2C: list and card of Yandex orders (money only with yandex.orders.money)
  'yandex.orders': ['warehouse'], // Stage 2C: create, pick units, assembled, handed over, delivered, cancel / return
  'yandex.orders.money': [], // commission %, sale prices after creation, unit costs and profit of a Yandex order
  'units.missing': ['warehouse'], // «Потеряна» and «Найдена»
  'units.return_decision': ['warehouse'], // a returned unit: back on stock or written off
  'units.writeoff': [], // write-off of a unit (На складе / Возврат на проверке / Потеряна)
  'units.correct': [], // correction of the expiry date or the status (obvious mistake)
  'yandex.sync': [], // Stage 2D: «Синхронизация Яндекса», «Проверить сейчас», «Требует внимания», «Закрыть как неактуальный»
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: StaffRole, permission: Permission): boolean {
  return role === 'admin' || (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);
}

export function permissionsOf(role: StaffRole): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}
