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
  { to: '/yandex-sync', label: 'Синхронизация Яндекса', permission: 'yandex.sync' },
  { to: '/products', label: 'Товары', permission: 'products.view' },
  { to: '/brands', label: 'Бренды', permission: 'settings.dictionaries' },
  { to: '/inventory', label: 'Склад', permission: 'inventory.view' },
  { to: '/purchases', label: 'Закупки', permission: 'purchases.view' },
  { to: '/customers', label: 'Клиенты', permission: 'customers.view' },
  { to: '/waitlist', label: 'Лист ожидания', permission: 'customers.view' },
  // 3.2: promos to customers with «Получать акции и новости» — admin and marketer
  { to: '/promo', label: 'Акции', permission: 'promo.send' },
  // 3.3: promo codes — admin, marketer (change), manager (view only)
  { to: '/promo-codes', label: 'Промокоды', permission: 'promo.view' },
  // 3.4: compatibility requests — admin and «специалист» answer, manager only looks (without the comment)
  { to: '/compat', label: 'Совместимость', permission: 'compat.view' },
  // Stage 3: money — admin only
  { to: '/analytics', label: 'Аналитика', permission: 'finance.manage' },
  { to: '/finance', label: 'Финансы', permission: 'finance.manage' },
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
