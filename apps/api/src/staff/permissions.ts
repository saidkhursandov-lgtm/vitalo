import type { StaffRole } from '@prisma/client';

/**
 * Who may do what in the admin panel (Master TZ §18). The server checks these on every request;
 * the admin UI only uses them to hide what the employee cannot do anyway.
 * - admin: everything (implicit, not listed below);
 * - manager: orders, payments, delivery, customers;
 * - warehouse: stock, picking (Paid -> Picking -> Handed to delivery);
 * - marketer: read-only catalog and dashboard funnel (promotions/newsletters come in later stages).
 * Money that is not for everyone: purchase cost (costs.view, admin only) and revenue (dashboard.revenue).
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
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: StaffRole, permission: Permission): boolean {
  return role === 'admin' || (PERMISSIONS[permission] as readonly StaffRole[]).includes(role);
}

export function permissionsOf(role: StaffRole): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}
