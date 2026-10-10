import { readFileSync } from 'fs';
import { join } from 'path';
import { reconcileState } from '../receiving/reconcile';
import { canMove, CORRECTABLE_FROM, CORRECTABLE_TO, onShelf, TRANSITIONS } from './unit-lifecycle';
import { defaultCommission, orderMoney } from './yandex-orders';

const MIGRATION = join(__dirname, '../../prisma/migrations/20261013100000_stage2e_order_units/migration.sql');

describe('unit life cycle', () => {
  it('the service table is exactly the database trigger table', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const fn = sql.slice(sql.indexOf('check_physical_unit_status()'));
    const pairs = [...fn.matchAll(/\('([A-Z_]+)', '([A-Z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    expect(pairs).toEqual(TRANSITIONS.map(([a, b]) => `${a}>${b}`).sort());
  });

  it('allowed and forbidden moves', () => {
    expect(canMove('IN_STOCK', 'ASSIGNED')).toBe(true);
    expect(canMove('ASSIGNED', 'YANDEX_DELIVERY')).toBe(true);
    expect(canMove('YANDEX_SOLD', 'RETURNED')).toBe(true);
    expect(canMove('RETURNED', 'IN_STOCK')).toBe(true);
    expect(canMove('IN_STOCK', 'YANDEX_SOLD')).toBe(false); // never skip the order steps
    expect(canMove('ASSIGNED', 'MISSING')).toBe(false); // a unit of an order is not marked lost
    expect(canMove('YANDEX_SOLD', 'IN_STOCK')).toBe(false); // only through a return and its check
    expect(canMove('VOIDED', 'IN_STOCK')).toBe(false);
    expect(canMove('IN_STOCK', 'VITALO_SOLD')).toBe(false); // never skip the order steps
    expect(canMove('ASSIGNED', 'VITALO_DELIVERY')).toBe(true); // stage 2E
    expect(canMove('VITALO_SOLD', 'RETURNED')).toBe(true);
  });

  it('every admin correction is an allowed move; shelf statuses', () => {
    for (const from of CORRECTABLE_FROM) for (const to of CORRECTABLE_TO) if (from !== to && !(from === 'RETURNED' && to !== 'MISSING')) expect(canMove(from, to)).toBe(true);
    expect(['IN_STOCK', 'ASSIGNED'].every((s) => onShelf(s as never))).toBe(true);
    expect(['YANDEX_DELIVERY', 'RETURNED', 'MISSING', 'WRITTEN_OFF'].some((s) => onShelf(s as never))).toBe(false);
  });
});

describe('Yandex order profit (S2C-6: no Yandex logistics)', () => {
  it('price − commission (price × %) − cost of the very units', () => {
    expect(orderMoney([{ qty: 2, unit_price_uzs: 100_000n }], [40_000n, 40_000n], 18.5)).toEqual({ revenue_uzs: 200_000, commission_uzs: 37_000, cost_uzs: 80_000, profit_uzs: 83_000 });
    expect(orderMoney([{ qty: 1, unit_price_uzs: 99_999n }], [50_000n], 18.5).commission_uzs).toBe(18_500); // 18 499.8 -> rounded to whole UZS
    expect(orderMoney([{ qty: 1, unit_price_uzs: 10_000n }], [20_000n], 18.5).profit_uzs).toBe(-11_850); // a loss is shown as it is
  });
});

describe('«Сверка» states', () => {
  it('ok, old orders without units (paid before 2E), unexplained', () => {
    expect(reconcileState({ difference: 0, assigned: 1, reserved: 1, sold: 0 })).toBe('ok');
    expect(reconcileState({ difference: 2, assigned: 0, reserved: 0, sold: 2 })).toBe('legacy_orders');
    expect(reconcileState({ difference: 1, assigned: 0, reserved: 0, sold: 2 })).toBe('unexplained');
    expect(reconcileState({ difference: 0, assigned: 2, reserved: 1, sold: 0 })).toBe('unexplained'); // a Yandex unit without its reservation
  });
});

describe('commission of a new order (S2C-11)', () => {
  it('from the product card, 18.5 where empty, weighted by revenue for several products', () => {
    expect(defaultCommission([{ revenue: 100_000, percent: 15 }])).toBe(15);
    expect(defaultCommission([{ revenue: 100_000, percent: null }])).toBe(18.5);
    expect(defaultCommission([{ revenue: 100_000, percent: 15 }, { revenue: 300_000, percent: 15 }])).toBe(15);
    expect(defaultCommission([{ revenue: 100_000, percent: 10 }, { revenue: 300_000, percent: null }])).toBe(16.38); // (10 000 + 55 500) / 400 000
    expect(defaultCommission([{ revenue: 0, percent: 12 }, { revenue: 0, percent: 20 }])).toBe(12);
  });
});
