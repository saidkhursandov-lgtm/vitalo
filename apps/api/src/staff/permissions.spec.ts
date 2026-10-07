import { can, PERMISSIONS, permissionsOf, type Permission } from './permissions';

describe('staff permissions', () => {
  it('admin can do everything', () => {
    expect(permissionsOf('admin')).toEqual(Object.keys(PERMISSIONS));
  });

  it('only admin manages settings, staff and reads the audit log', () => {
    for (const p of ['settings.manage', 'staff.manage', 'audit.view', 'products.edit', 'costs.view', 'settings.dictionaries', 'purchases.manage', 'purchases.view_costs'] as Permission[]) {
      expect(['manager', 'warehouse', 'marketer'].filter((r) => can(r as never, p))).toEqual([]);
    }
  });

  it('warehouse: stock and picking, but no payments, delivery, customers or cancellation', () => {
    expect(can('warehouse', 'inventory.edit')).toBe(true);
    expect(can('warehouse', 'orders.fulfil')).toBe(true);
    for (const p of ['orders.payment', 'orders.deliver', 'orders.cancel', 'orders.edit', 'customers.view'] as Permission[]) {
      expect(can('warehouse', p)).toBe(false);
    }
  });

  it('manager: orders and customers, but cannot change stock or products', () => {
    expect(can('manager', 'orders.payment')).toBe(true);
    expect(can('manager', 'customers.block')).toBe(true);
    expect(can('manager', 'inventory.edit')).toBe(false);
    expect(can('manager', 'products.edit')).toBe(false);
  });

  it('marketer: read-only catalog and dashboard, without revenue', () => {
    expect(permissionsOf('marketer')).toEqual(['dashboard.view', 'products.view', 'yandex.price.view']);
  });

  it('stage 1: Yandex price seen by admin, manager, marketer (not warehouse); synced by admin and manager', () => {
    expect((['admin', 'manager', 'warehouse', 'marketer'] as const).filter((r) => can(r, 'yandex.price.view'))).toEqual(['admin', 'manager', 'marketer']);
    expect((['admin', 'manager', 'warehouse', 'marketer'] as const).filter((r) => can(r, 'yandex.price.sync'))).toEqual(['admin', 'manager']);
  });

  it('stage 2A: purchases are seen by admin and manager; changed and priced by admin only', () => {
    expect((['admin', 'manager', 'warehouse', 'marketer'] as const).filter((r) => can(r, 'purchases.view'))).toEqual(['admin', 'manager']);
    expect((['admin', 'manager', 'warehouse', 'marketer'] as const).filter((r) => can(r, 'purchases.manage'))).toEqual(['admin']);
    expect((['admin', 'manager', 'warehouse', 'marketer'] as const).filter((r) => can(r, 'purchases.view_costs'))).toEqual(['admin']);
  });

  it('stage 0: cost price only for admin, revenue for admin and manager', () => {
    expect((['admin', 'manager', 'warehouse', 'marketer'] as const).filter((r) => can(r, 'costs.view'))).toEqual(['admin']);
    expect((['admin', 'manager', 'warehouse', 'marketer'] as const).filter((r) => can(r, 'dashboard.revenue'))).toEqual(['admin', 'manager']);
  });
});
