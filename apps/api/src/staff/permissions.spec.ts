import { can, PERMISSIONS, permissionsOf, type Permission } from './permissions';

describe('staff permissions', () => {
  it('admin can do everything', () => {
    expect(permissionsOf('admin')).toEqual(Object.keys(PERMISSIONS));
  });

  it('only admin manages settings, staff and reads the audit log', () => {
    for (const p of ['settings.manage', 'staff.manage', 'audit.view', 'products.edit'] as Permission[]) {
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

  it('marketer: read-only catalog and dashboard', () => {
    expect(permissionsOf('marketer')).toEqual(['dashboard.view', 'products.view']);
  });
});
