import type { Permission } from './auth';

export interface NavItem {
  /** Path, optionally with `?tab=…` — the menu then opens that tab of the page. */
  to: string;
  label: string;
  permission: Permission;
  /** Other tabs of the same page that also belong to this item. */
  also?: string[];
  /** Other pages that belong to this item (e.g. the Yandex list and cards under «Заказы»). */
  paths?: string[];
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

/**
 * Генплан, этап 2 (аудит, п. 6): the menu in 7 groups. Each item appears only with its permission (the API enforces
 * the same rules); a group without items is hidden. Several items may open tabs of one page (Склад, Настройки …).
 */
export const NAV_GROUPS: NavGroup[] = [
  { id: 'dashboard', label: 'Дашборд', items: [{ to: '/', label: 'Дашборд', permission: 'dashboard.view' }] },
  {
    id: 'sales',
    label: 'Продажи',
    items: [
      // both channels in one list; Mini App and Yandex — a switch above the list (генплан, этап 2)
      { to: '/orders', label: 'Заказы', permission: 'orders.view', paths: ['/yandex-orders'] },
      { to: '/customers', label: 'Клиенты', permission: 'customers.view' },
      { to: '/waitlist', label: 'Лист ожидания', permission: 'customers.view' },
      // 3.4: questions from the cart — admin and «специалист» answer, manager only looks
      { to: '/compat', label: 'Вопросы о совместимости', permission: 'compat.view' },
    ],
  },
  {
    id: 'catalog',
    label: 'Каталог',
    items: [
      { to: '/products', label: 'Товары', permission: 'products.view' },
      { to: '/brands', label: 'Бренды', permission: 'settings.dictionaries' },
      { to: '/settings?tab=dicts', label: 'Справочники', permission: 'settings.manage' },
      // the knowledge of VITALO AI: substances, rules, which substance is in which product
      { to: '/compat?tab=rules', label: 'База знаний AI', permission: 'compat.view', also: ['substances', 'products'] },
    ],
  },
  {
    id: 'stock',
    label: 'Закупки и склад',
    items: [
      { to: '/purchases', label: 'Закупки', permission: 'purchases.view' },
      { to: '/inventory?tab=receiving', label: 'Приёмка', permission: 'receiving.perform' },
      { to: '/inventory', label: 'Остатки', permission: 'inventory.view' },
      { to: '/inventory?tab=units', label: 'Банки', permission: 'units.view' },
      { to: '/inventory?tab=reconcile', label: 'Сверка', permission: 'units.view' },
      { to: '/inventory?tab=movements', label: 'История движений', permission: 'inventory.view' },
      { to: '/settings?tab=print', label: 'Печать этикеток', permission: 'settings.manage' },
      // D-57: iHerb wishlist prices, history and auto price — admin only (margins)
      { to: '/iherb', label: 'iHerb и цены', permission: 'iherb.prices' },
      // D-60: «Под заказ из США» — what to order on iHerb, parcels and their stages
      { to: '/cross-border', label: 'Поставки под заказ', permission: 'cross_border.view' },
    ],
  },
  {
    id: 'marketing',
    label: 'Маркетинг',
    items: [
      // D-53 (D-22): home banners, manifest, home texts and cart upsell — admin and marketer
      { to: '/storefront', label: 'Витрина', permission: 'marketing.content' },
      // 3.7: sales with their own prices and skins — admin, marketer (change), manager (view only)
      { to: '/campaigns', label: 'Акции', permission: 'promo.view' },
      // 3.3: promo codes — admin, marketer (change), manager (view only)
      { to: '/promo-codes', label: 'Промокоды', permission: 'promo.view' },
      // 3.2: messages to customers with «Получать акции и новости» — admin and marketer
      { to: '/promo', label: 'Рассылки', permission: 'promo.send' },
    ],
  },
  {
    id: 'finance',
    label: 'Финансы и аналитика',
    items: [
      // Stage 3: money — admin only
      { to: '/analytics', label: 'Аналитика', permission: 'finance.manage' },
      { to: '/finance', label: 'Расходы', permission: 'finance.manage' },
      { to: '/finance?tab=tax', label: 'Налог', permission: 'finance.manage' },
      { to: '/finance?tab=payroll', label: 'Зарплаты', permission: 'finance.manage' },
    ],
  },
  {
    id: 'system',
    label: 'Система',
    items: [
      { to: '/settings', label: 'Оплата', permission: 'settings.manage' },
      { to: '/settings?tab=tariffs', label: 'Доставка', permission: 'settings.manage' },
      { to: '/settings?tab=texts', label: 'Тексты и контакты', permission: 'settings.manage' },
      { to: '/settings?tab=docs', label: 'Документы', permission: 'settings.manage' },
      { to: '/settings?tab=ai', label: 'VITALO AI', permission: 'settings.manage' },
      // D-57 узел 5: the admin AI analyst (its own key and budget) — admin only
      { to: '/ai-analyst', label: 'AI-аналитик', permission: 'ai_analyst.use' },
      { to: '/settings?tab=staff', label: 'Сотрудники', permission: 'settings.manage' },
      { to: '/yandex-sync', label: 'Синхронизация Яндекса', permission: 'yandex.sync' },
      { to: '/audit', label: 'Журнал аудита', permission: 'audit.view' },
    ],
  },
];

/** The groups the employee sees, each with only the items they may open. */
export function groupsFor(permissions: Permission[]): NavGroup[] {
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => permissions.includes(i.permission)) })).filter((g) => g.items.length > 0);
}

/** All items the employee sees, in menu order. */
export function navFor(permissions: Permission[]): NavItem[] {
  return groupsFor(permissions).flatMap((g) => g.items);
}

/** Where to land after login: the first section the employee may open. */
export function homeFor(permissions: Permission[]): string {
  return navFor(permissions)[0]?.to ?? '/no-access';
}

const split = (to: string) => {
  const [path, query = ''] = to.split('?');
  return { path, tab: new URLSearchParams(query).get('tab') };
};

/**
 * Which menu item the current address belongs to: the same page (or a page under it, e.g. /orders/123) and the
 * same tab; an item without a tab stands for the page's default tab and for tabs that have no item of their own.
 */
export function activeItem(items: NavItem[], pathname: string, search: string): NavItem | undefined {
  const tab = new URLSearchParams(search).get('tab');
  const under = (path: string) => (path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`));
  const matched = (i: NavItem) => [split(i.to).path, ...(i.paths ?? [])].filter(under).reduce((a, p) => Math.max(a, p.length), -1);
  const onPage = items.filter((i) => matched(i) >= 0);
  // the longest matching path wins: /yandex-orders/1 belongs to «Заказы» through its extra path
  const longest = Math.max(0, ...onPage.map(matched));
  const same = onPage.filter((i) => matched(i) === longest);
  return same.find((i) => tab !== null && (split(i.to).tab === tab || !!i.also?.includes(tab))) ?? same.find((i) => split(i.to).tab === null) ?? same[0];
}
