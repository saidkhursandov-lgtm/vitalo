import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, errorText, qs } from './lib/api';
import type { Permission } from './lib/auth';
import { dateTime, money } from './lib/format';
import { homeFor, navFor } from './lib/nav';
import { TestBadge } from './components/OrderFinance';
import { monthRange } from './pages/Analytics';
import { monthName } from './pages/Finance';
import { Diff } from './pages/Audit';
import { ReasonPicker } from './components/Reason';
import { ordersRu } from './pages/YandexSync';
import { ShipBy } from './pages/YandexOrders';
import { fireEvent } from '@testing-library/react';

afterEach(cleanup);

/** Same lists as apps/api/src/staff/permissions.ts permissionsOf(role). */
const PERMS: Record<string, Permission[]> = {
  warehouse: ['orders.view', 'orders.fulfil', 'products.view', 'inventory.view', 'inventory.edit', 'receiving.perform', 'units.view', 'yandex.orders.view', 'yandex.orders', 'units.missing', 'units.return_decision'],
  marketer: ['dashboard.view', 'products.view', 'yandex.price.view'],
  manager: ['dashboard.view', 'orders.view', 'orders.payment', 'orders.fulfil', 'orders.deliver', 'orders.cancel', 'orders.edit', 'products.view', 'inventory.view', 'customers.view', 'customers.block', 'dashboard.revenue', 'yandex.price.view', 'yandex.price.sync', 'purchases.view', 'receiving.perform', 'units.view', 'products.label', 'yandex.orders.view'],
};

describe('menu by role', () => {
  const labels = (role: string) => navFor(PERMS[role]).map((n) => n.label);

  it('warehouse: orders, Yandex orders, products, stock — no settings, customers, audit', () => {
    expect(labels('warehouse')).toEqual(['Заказы', 'Заказы Яндекса', 'Товары', 'Склад']);
    expect(homeFor(PERMS.warehouse)).toBe('/orders');
  });

  it('marketer: dashboard and products only', () => {
    expect(labels('marketer')).toEqual(['Дашборд', 'Товары']);
  });

  it('manager: everything except settings and audit; Yandex orders to view (stage 2C)', () => {
    expect(labels('manager')).toEqual(['Дашборд', 'Заказы', 'Заказы Яндекса', 'Товары', 'Склад', 'Закупки', 'Клиенты']);
  });
});

describe('formatting and errors', () => {
  it('money and Tashkent time', () => {
    expect(money(1250000)).toBe('1 250 000 сум');
    expect(money(null)).toBe('—');
    expect(dateTime('2026-10-02T19:30:00Z')).toContain('03.10.2026');
  });

  it('API error codes become Russian messages', () => {
    expect(errorText(new ApiError(409, 'ORDER_LOCKED', {}))).toMatch(/передан в доставку/);
    expect(errorText(new ApiError(403, 'FORBIDDEN_FOR_ROLE', {}))).toMatch(/нет прав/);
    expect(errorText(new ApiError(400, undefined, { message: ['reason should not be empty'] }))).toBe('Проверьте поля: reason should not be empty');
    expect(errorText(new TypeError('fetch failed'))).toMatch(/Нет связи/);
  });

  it('query strings skip empty values', () => {
    expect(qs({ q: 'abc', status: '', low_only: false, page: 2 })).toBe('?q=abc&page=2');
  });
});

describe('audit diff', () => {
  it('shows before/after per field and highlights changes', () => {
    render(<Diff before={{ price_uzs: 99000, sku: 'A' }} after={{ price_uzs: 95000, sku: 'A' }} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(['price_uzs9900095000', 'skuAA']);
    expect(rows[0].className).toBe('changed');
    expect(rows[1].className).toBe('');
  });
});

describe('reason picker', () => {
  it('a ready answer or «Другое» with own text', () => {
    let reason = '';
    render(<ReasonPicker options={['Истёк срок годности']} onChange={(r) => (reason = r)} />);
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'Истёк срок годности' } });
    expect(reason).toBe('Истёк срок годности');
    fireEvent.change(select, { target: { value: '__other' } });
    expect(reason).toBe('');
    fireEvent.change(screen.getByLabelText(/Ваша причина/), { target: { value: '  Уронили банку  ' } });
    expect(reason).toBe('Уронили банку');
  });
});

describe('batch close wording', () => {
  it('Russian plural of «заказ»', () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25, 100, 101, 112].map(ordersRu)).toEqual(['1 заказ', '2 заказа', '5 заказов', '11 заказов', '12 заказов', '21 заказ', '22 заказа', '25 заказов', '100 заказов', '101 заказ', '112 заказов']);
  });
});

describe('Yandex order: «Отгрузить до»', () => {
  const text = (el: Parameters<typeof render>[0]) => {
    const { container } = render(el);
    const out = container.textContent ?? '';
    cleanup();
    return out;
  };
  it('date with or without the time; no deadline is a dash', () => {
    expect(text(<ShipBy value={{ date: '2026-10-14', time: '12:00' }} status="NEW" today="2026-10-10" />)).toBe('14.10.2026 12:00');
    expect(text(<ShipBy value={{ date: '2026-10-14', time: null }} status="NEW" today="2026-10-10" />)).toBe('14.10.2026');
    expect(text(<ShipBy value={null} status="NEW" today="2026-10-10" />)).toBe('—');
  });
  it('marked «сегодня» and «просрочено» only while the order is not handed over', () => {
    expect(text(<ShipBy value={{ date: '2026-10-14', time: null }} status="ASSEMBLED" today="2026-10-14" />)).toBe('14.10.2026 — сегодня');
    expect(text(<ShipBy value={{ date: '2026-10-14', time: '09:00' }} status="NEW" today="2026-10-15" />)).toBe('14.10.2026 09:00 — просрочено');
    expect(text(<ShipBy value={{ date: '2026-10-14', time: null }} status="HANDED_TO_DELIVERY" today="2026-10-15" />)).toBe('14.10.2026');
    expect(text(<ShipBy value={{ date: '2026-10-14', time: null }} status="CANCELLED" today="2026-10-15" />)).toBe('14.10.2026');
  });
});

describe('stage 3: money is for the admin only', () => {
  it('«Аналитика» and «Финансы» appear only with finance.manage (no role but admin has it)', () => {
    for (const role of Object.keys(PERMS)) {
      expect(PERMS[role]).not.toContain('finance.manage');
      expect(navFor(PERMS[role]).map((n) => n.label)).not.toEqual(expect.arrayContaining(['Аналитика']));
      expect(navFor(PERMS[role]).map((n) => n.label)).not.toEqual(expect.arrayContaining(['Финансы']));
    }
    expect(navFor(['finance.manage']).map((n) => n.to)).toEqual(['/analytics', '/finance']);
  });

  it('periods and month names', () => {
    expect(monthRange('2026-11-17', 0)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthRange('2027-01-05', -1)).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(monthRange('2028-03-05', -1)).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthName('2026-11')).toBe('ноябрь 2026');
    expect(money(-15000).replace(/\s/g, ' ')).toBe('-15 000 сум');
  });

  it('«ТЕСТ» badge only on test orders', () => {
    const { container, rerender } = render(<TestBadge show={false} />);
    expect(container.textContent).toBe('');
    rerender(<TestBadge show />);
    expect(container.textContent).toBe('ТЕСТ');
  });
});
