import { renderNotification } from '../notifications/notification-templates';
import { addDays, CROSS_BORDER_DEFAULTS, crossBorderOkRow, customerCancel, expectedWindow, isIherbSku, isOverdue, lineStage, mergeCrossBorderSettings, orderStage } from './cross-border';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
// 2026-11-09 10:00 Tashkent
const NOW = new Date('2026-11-09T05:00:00.000Z');

describe('D-60: «Под заказ из США» rules', () => {
  it('iHerb SKUs: VTL-H001… and VTL-GH001… go «из США» by themselves; the checkbox works for the others', () => {
    expect(['VTL-H001', 'VTL-GH001', 'vtl-h12'].map(isIherbSku)).toEqual([true, true, true]);
    expect(['VTL-HAIR', 'VTL-G001', 'OZN-A1', 'VTL-MG', '', null].map(isIherbSku)).toEqual([false, false, false, false, false, false]);
    const p = { sku: 'VTL-GH001', cross_border_eligible: false, status: 'active' };
    expect(crossBorderOkRow(p)).toBe(true);
    expect(crossBorderOkRow({ ...p, status: 'hidden' })).toBe(false);
    expect(crossBorderOkRow({ ...p, iherb_snapshots: [{ in_stock: false }] })).toBe(false);
    expect(crossBorderOkRow({ ...p, sku: 'VTL-MG' })).toBe(false);
    expect(crossBorderOkRow({ ...p, sku: 'VTL-MG', cross_border_eligible: true })).toBe(true);
  });

  it('settings: defaults, wrong values fall back, max ≥ min and guarantee ≥ max', () => {
    expect(mergeCrossBorderSettings(null)).toEqual({ days_min: 7, days_max: 14, guarantee_days: 21 });
    expect(mergeCrossBorderSettings({ days_min: 10, days_max: 5, guarantee_days: 3 })).toEqual({ days_min: 10, days_max: 10, guarantee_days: 10 });
    expect(mergeCrossBorderSettings({ days_min: 0, days_max: 'x', guarantee_days: 1.5 })).toEqual(CROSS_BORDER_DEFAULTS);
  });

  it('the window is counted in Tashkent days (late evening UTC is already tomorrow in Tashkent)', () => {
    expect(expectedWindow(NOW, CROSS_BORDER_DEFAULTS)).toEqual({ expected_from: d('2026-11-16'), expected_to: d('2026-11-23') });
    expect(addDays(new Date('2026-11-09T20:00:00.000Z'), 0)).toEqual(d('2026-11-10'));
  });

  it('stage: the slowest line; a received parcel without jars for the line is still «arrived»', () => {
    expect(lineStage({ arrived_at: null, batch_stage: null })).toBe('paid');
    expect(lineStage({ arrived_at: null, batch_stage: 'received' })).toBe('arrived_uz');
    expect(orderStage(true, [{ arrived_at: NOW, batch_stage: 'shipped' }, { arrived_at: null, batch_stage: 'shipped' }])).toBe('shipped');
    expect(orderStage(true, [{ arrived_at: NOW, batch_stage: null }])).toBe('in_stock');
    expect(orderStage(false, [{ arrived_at: null, batch_stage: null }])).toBeNull();
  });

  it('the customer cancels: before the order in the USA, or after the guarantee without jars; never once picking started', () => {
    const s = CROSS_BORDER_DEFAULTS;
    const paidAt = new Date('2026-11-01T05:00:00.000Z');
    expect(customerCancel({ status: 'paid', paid_at: paidAt, stage: 'paid' }, s, NOW)).toEqual({ allowed: true, reason: 'not_ordered' });
    expect(customerCancel({ status: 'paid', paid_at: paidAt, stage: 'shipped' }, s, NOW)).toEqual({ allowed: false });
    expect(customerCancel({ status: 'paid', paid_at: paidAt, stage: 'shipped' }, s, new Date('2026-11-22T05:00:00.000Z'))).toEqual({ allowed: true, reason: 'guarantee' });
    expect(customerCancel({ status: 'paid', paid_at: paidAt, stage: 'in_stock' }, s, new Date('2026-12-30T05:00:00.000Z'))).toEqual({ allowed: false });
    expect(customerCancel({ status: 'picking', paid_at: paidAt, stage: 'paid' }, s, NOW)).toEqual({ allowed: false });
  });

  it('overdue: after the last promised day, once per date', () => {
    const o = { status: 'paid' as const, stage: 'shipped' as const, expected_to: d('2026-11-08'), overdue_for: null };
    expect(isOverdue(o, NOW)).toBe(true);
    expect(isOverdue({ ...o, expected_to: d('2026-11-09') }, NOW)).toBe(false);
    expect(isOverdue({ ...o, overdue_for: d('2026-11-08') }, NOW)).toBe(false);
    expect(isOverdue({ ...o, stage: 'in_stock' }, NOW)).toBe(false);
  });

  it('messages: the window, the stage, the expiry, the delay with its reason (RU and UZ)', () => {
    const base = { order_number: '091126-001', expected_from: '2026-11-16', expected_to: '2026-11-23' };
    expect(renderNotification('order.cb_paid', { ...base, lang: 'ru' })).toContain('Ожидаемая доставка: 16.11.2026 – 23.11.2026.');
    expect(renderNotification('order.cb_stage', { ...base, stage: 'shipped', lang: 'uz' })).toContain('AQSHdan jo‘natildi');
    expect(renderNotification('order.cb_stage', { ...base, stage: 'in_stock', expiry: '2028-03-01', lang: 'ru' })).toContain('Срок годности: до 01.03.2028.');
    expect(renderNotification('order.cb_delay', { ...base, expected_to: '2026-11-30', expected_from: '2026-11-30', reason: 'таможня', lang: 'ru' })).toMatch(/Ожидаемая доставка: 30\.11\.2026\.\nПричина: таможня/);
  });
});
