import { reconcileCartLine, ReconcileInput } from './cart-reconcile';

const base: ReconcileInput = {
  product_id: 'p1',
  qty: 2,
  snapshot_price_uzs: 50_000,
  current_price_uzs: 50_000,
  sellable: true,
  available_qty: 10,
};

describe('reconcileCartLine', () => {
  it('keeps an unchanged line as is, without warnings', () => {
    expect(reconcileCartLine(base)).toEqual({ status: 'available', qty: 2, unit_price_uzs: 50_000, warnings: [] });
  });

  it('takes the new price and warns when the price changed', () => {
    const r = reconcileCartLine({ ...base, current_price_uzs: 45_000 });
    expect(r.unit_price_uzs).toBe(45_000);
    expect(r.warnings).toEqual([{ code: 'price_changed', product_id: 'p1', old_price_uzs: 50_000, new_price_uzs: 45_000 }]);
  });

  it('reduces qty to available stock and warns', () => {
    const r = reconcileCartLine({ ...base, qty: 7, available_qty: 3 });
    expect(r.qty).toBe(3);
    expect(r.warnings).toEqual([{ code: 'qty_reduced', product_id: 'p1', requested_qty: 7, available_qty: 3 }]);
  });

  it('reports both warnings together', () => {
    const r = reconcileCartLine({ ...base, qty: 5, available_qty: 1, current_price_uzs: 60_000 });
    expect(r.warnings.map((w) => w.code)).toEqual(['price_changed', 'qty_reduced']);
  });

  it('marks a line without stock as unavailable but keeps its qty', () => {
    const r = reconcileCartLine({ ...base, available_qty: 0 });
    expect(r).toMatchObject({ status: 'unavailable', qty: 2, warnings: [{ code: 'out_of_stock' }] });
  });

  it('marks an archived/hidden product as unavailable even with stock', () => {
    expect(reconcileCartLine({ ...base, sellable: false }).status).toBe('unavailable');
  });

  it('3.7: a sale price whose sale is over → «Акция завершилась», the regular price is taken', () => {
    const r = reconcileCartLine({ ...base, snapshot_price_uzs: 40_000, current_price_uzs: 50_000, snapshot_campaign_id: 'c1', current_campaign_id: null });
    expect(r).toMatchObject({ unit_price_uzs: 50_000, warnings: [{ code: 'campaign_ended', old_price_uzs: 40_000, new_price_uzs: 50_000 }] });
    // a sale that started while the line waited is just a new (lower) price
    expect(reconcileCartLine({ ...base, current_price_uzs: 40_000, current_campaign_id: 'c1' }).warnings).toEqual([{ code: 'price_changed', product_id: 'p1', old_price_uzs: 50_000, new_price_uzs: 40_000 }]);
  });

  it('caps a line at 99 units', () => {
    expect(reconcileCartLine({ ...base, qty: 150, available_qty: 500 }).qty).toBe(99);
  });
});
