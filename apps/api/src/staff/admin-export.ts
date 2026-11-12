import { Controller, Get, Injectable, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AnalyticsQuery, ExpensesQuery } from '../finance/finance.controller';
import { FinanceService } from '../finance/finance.service';
import { AllOrdersQuery, AllOrdersService } from './admin-all-orders';
import { AdminInventoryService, StockQuery } from './admin-inventory';
import { AuditService } from './audit.service';
import { can } from './permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

type Cell = string | number | null | undefined;

/** One CSV cell: «;» as the separator (Excel in Russian), quotes doubled, formulas neutralised (=, +, -, @ in text). */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Аудит админки 2.14: UTF-8 with BOM so that Excel shows Cyrillic at once; Windows line ends. */
export function toCsv(head: string[], rows: Cell[][]): string {
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

const ORDER_STATUS: Record<string, string> = {
  new: 'Ожидает подтверждения',
  awaiting_payment: 'Ожидает оплаты',
  paid: 'Оплачен',
  picking: 'Собирается',
  handed_to_delivery: 'Передан курьеру',
  in_transit: 'В пути',
  delivered: 'Доставлен',
  cancelled: 'Отменён',
  return: 'Возврат',
  NEW: 'Новый',
  ASSEMBLED: 'Собран',
  HANDED_TO_DELIVERY: 'Передан в доставку',
  DELIVERED: 'Доставлен',
  CANCELLED: 'Отменён',
  RETURNED: 'Возврат',
};
const PAYMENT_METHOD: Record<string, string> = { card_transfer: 'Перевод на карту', bank_transfer: 'Перевод по реквизитам', cod: 'При получении', payme: 'Payme', click: 'Click', uzum: 'Uzum' };
const PAYMENT_STATUS: Record<string, string> = { payment_pending: 'Ожидает', payment_success: 'Оплачено', payment_failed: 'Ошибка', payment_cancelled: 'Отменено' };

/** Never more than this many rows in one file: a bigger period is exported in parts. */
export const EXPORT_MAX_ROWS = 10_000;
const tashkentDay = (d: Date) => new Date(d.getTime() + 5 * 3600_000).toISOString().slice(0, 10);
const tashkentTime = (d: Date) => new Date(d.getTime() + 5 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');

@Injectable()
export class AdminExportService {
  constructor(
    private readonly allOrders: AllOrdersService,
    private readonly inventory: AdminInventoryService,
    private readonly finance: FinanceService,
    private readonly audit: AuditService,
  ) {}

  /** The same filter as the order list, every page. */
  async orders(q: AllOrdersQuery, allowed: { vitalo: boolean; yandex: boolean }) {
    const rows: Cell[][] = [];
    for (let page = 1; rows.length < EXPORT_MAX_ROWS; page++) {
      const r = await this.allOrders.list({ ...q, page, page_size: 100 }, allowed);
      for (const o of r.items)
        rows.push([
          o.number,
          o.channel === 'vitalo' ? 'Mini App' : 'Яндекс Маркет',
          tashkentTime(o.created_at),
          ORDER_STATUS[o.status] ?? o.status,
          o.payment_method ? (PAYMENT_METHOD[o.payment_method] ?? o.payment_method) : '',
          o.payment_status ? (PAYMENT_STATUS[o.payment_status] ?? o.payment_status) : '',
          o.customer,
          o.qty,
          o.total_uzs,
          o.is_test ? 'да' : '',
        ]);
      if (page >= r.total_pages) break;
    }
    return { name: 'zakazy', count: rows.length, csv: toCsv(['Номер', 'Канал', 'Создан', 'Статус', 'Оплата', 'Статус оплаты', 'Покупатель', 'Штук', 'Сумма, сум', 'Тестовый'], rows) };
  }

  /** The whole shelf (not only what moved lately); cost — only with costs.view. */
  async stock(q: StockQuery, costs: boolean) {
    const rows: Cell[][] = [];
    for (let page = 1; rows.length < EXPORT_MAX_ROWS; page++) {
      const r = await this.inventory.stock({ ...q, show_all: true, page }, costs);
      for (const i of r.items) rows.push([i.sku, i.name_ru, i.actual_qty, i.reserved_qty, i.available_qty, i.min_stock, i.days_of_stock, i.low ? 'да' : '']);
      if (page >= r.total_pages) break;
    }
    return { name: 'ostatki', count: rows.length, csv: toCsv(['Артикул', 'Товар', 'На складе', 'В резерве', 'Доступно', 'Минимум', 'Дней запаса', 'Мало'], rows) };
  }

  async productAnalytics(q: AnalyticsQuery) {
    const a = await this.finance.analytics(q);
    const rows: Cell[][] = a.products.map((p) => [p.sku, p.name, p.qty, p.revenue, p.cost, p.commission, p.profit, p.margin_percent, p.incomplete ? 'нет себестоимости' : '']);
    return {
      name: `analitika-${q.from}-${q.to}`,
      count: rows.length,
      csv: toCsv(['Артикул', 'Товар', 'Продано, шт', 'Выручка, сум', 'Себестоимость, сум', 'Комиссия, сум', 'Прибыль, сум', 'Маржа, %', 'Примечание'], rows),
    };
  }

  async expenses(q: ExpensesQuery) {
    const e = await this.finance.expenses(q);
    const rows: Cell[][] = e.items.map((i) => [i.spent_on, i.category, i.amount_uzs, i.comment]);
    return { name: 'raskhody', count: rows.length, csv: toCsv(['Дата', 'Категория', 'Сумма, сум', 'Комментарий'], rows) };
  }

  /** Sends the file and writes «who exported what» to the audit log (export.*). */
  async send(res: Response, staffId: string, kind: string, filter: object, file: { name: string; count: number; csv: string }) {
    await this.audit.log({ staffId, action: `export.${kind}`, entityType: 'export', after: { filter, rows: file.count } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vitalo-${file.name}-${tashkentDay(new Date())}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.csv);
  }
}

@ApiTags('staff: export')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/export')
export class AdminExportController {
  constructor(private readonly exporter: AdminExportService) {}

  @Get('orders')
  @RequirePermission('orders.view', 'yandex.orders.view')
  async orders(@CurrentStaff() me: StaffContext, @Query() q: AllOrdersQuery, @Res() res: Response) {
    const file = await this.exporter.orders(q, { vitalo: can(me.staff.role, 'orders.view'), yandex: can(me.staff.role, 'yandex.orders.view') });
    await this.exporter.send(res, me.staff.id, 'orders', q, file);
  }

  @Get('stock')
  @RequirePermission('inventory.view')
  async stock(@CurrentStaff() me: StaffContext, @Query() q: StockQuery, @Res() res: Response) {
    const file = await this.exporter.stock(q, can(me.staff.role, 'costs.view'));
    await this.exporter.send(res, me.staff.id, 'stock', q, file);
  }

  @Get('product-analytics')
  @RequirePermission('finance.manage')
  async productAnalytics(@CurrentStaff() me: StaffContext, @Query() q: AnalyticsQuery, @Res() res: Response) {
    await this.exporter.send(res, me.staff.id, 'product_analytics', q, await this.exporter.productAnalytics(q));
  }

  @Get('expenses')
  @RequirePermission('finance.manage')
  async expenses(@CurrentStaff() me: StaffContext, @Query() q: ExpensesQuery, @Res() res: Response) {
    await this.exporter.send(res, me.staff.id, 'expenses', q, await this.exporter.expenses(q));
  }
}
