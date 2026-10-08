import type { Permission } from './auth';

export interface NavItem {
  to: string;
  label: string;
  permission: Permission;
}

/** Sidebar sections; each appears only with its permission (the API enforces the same rules). */
export const NAV: NavItem[] = [
  { to: '/', label: 'Дашборд', permission: 'dashboard.view' },
  { to: '/orders', label: 'Заказы', permission: 'orders.view' },
  { to: '/yandex-orders', label: 'Заказы Яндекса', permission: 'yandex.orders.view' },
  { to: '/products', label: 'Товары', permission: 'products.view' },
  { to: '/inventory', label: 'Склад', permission: 'inventory.view' },
  { to: '/purchases', label: 'Закупки', permission: 'purchases.view' },
  { to: '/customers', label: 'Клиенты', permission: 'customers.view' },
  { to: '/settings', label: 'Настройки', permission: 'settings.manage' },
  { to: '/audit', label: 'Журнал аудита', permission: 'audit.view' },
];

export function navFor(permissions: Permission[]): NavItem[] {
  return NAV.filter((n) => permissions.includes(n.permission));
}

/** Where to land after login: the first section the employee may open. */
export function homeFor(permissions: Permission[]): string {
  return navFor(permissions)[0]?.to ?? '/no-access';
}
