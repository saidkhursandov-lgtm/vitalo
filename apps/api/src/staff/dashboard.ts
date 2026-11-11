import { Controller, Get, Injectable, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { OrderStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { can } from './permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';
import { AnalyticsService } from '../analytics/analytics.module';
import { tashkentDateString } from '../common/tashkent';
import { AiService } from '../compat/ai.service';
import { tashkentMonthStart } from '../compat/ai';
import type { Channel } from '../finance/finance-math';
import { FinanceService } from '../finance/finance.service';

/** Orders that have been paid. */
export const PAID_STATUSES: OrderStatus[] = ['paid', 'picking', 'handed_to_delivery', 'in_transit', 'delivered'];

export class FunnelQuery {
  @ApiPropertyOptional({ enum: ['today', '7', '30'], default: '7' }) @IsOptional() @IsIn(['today', '7', '30']) period: 'today' | '7' | '30' = '7';
}

/** Start of "today" in Tashkent (UTC+5), or N days back. */
export function periodStart(period: 'today' | '7' | '30', now = new Date()): Date {
  if (period !== 'today') return new Date(now.getTime() - Number(period) * 86_400_000);
  const t = new Date(now.getTime() + 5 * 3600_000);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - 5 * 3600_000);
}

export class DashboardQuery {
  @ApiPropertyOptional({ enum: [1, 7, 30, 90], default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsIn([1, 7, 30, 90])
  days: number = 30;
}

/** What an employee may see on the dashboard (the server leaves the rest out). */
export interface DashboardViewer {
  /** revenue, average check, revenue per product (admin, manager) */
  revenue: boolean;
  /** gross margin — needs the cost of the jars (admin) */
  margin: boolean;
  /** VITALO AI spend this month against the budget (admin) */
  ai: boolean;
}

/** YYYY-MM-DD of a day N days before `day`. */
const minusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/**
 * Генплан, этап 2 (аудит, п. 7): the dashboard. ONE revenue rule with «Аналитика» (D-55): a sale is an order of either
 * channel that became «Доставлен», counted on that day, goods only (the delivery the customer pays is a transit,
 * S3-2); a return subtracts it on the day of the return; test orders are never counted (finance.saleEvents).
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
    private readonly ai: AiService,
  ) {}

  async get(days: number, viewer: DashboardViewer, now = new Date()) {
    const to = tashkentDateString(now);
    const from = minusDays(to, days - 1);
    const fromTs = new Date(`${from}T00:00:00+05:00`);

    const events = (await this.finance.saleEvents()).filter((e) => e.day >= from && e.day <= to);
    const dayList = Array.from({ length: days }, (_, i) => minusDays(to, days - 1 - i));
    const byDay = new Map(dayList.map((d) => [d, { day: d, vitalo_orders: 0, yandex_orders: 0, vitalo_revenue_uzs: 0, yandex_revenue_uzs: 0 }]));
    const channels: Record<Channel, { orders: number; revenue_uzs: number }> = { vitalo: { orders: 0, revenue_uzs: 0 }, yandex: { orders: 0, revenue_uzs: 0 } };
    const products = new Map<string, { product_id: string; sku: string; name_ru: string; qty: number; revenue_uzs: number }>();
    let units = 0;
    let withCost = 0;
    let cost = 0;
    let withoutCost = 0;
    for (const e of events) {
      const revenue = e.lines.reduce((sum, l) => sum + l.revenue, 0) * e.sign;
      const d = byDay.get(e.day)!;
      if (e.channel === 'vitalo') {
        d.vitalo_orders += e.sign;
        d.vitalo_revenue_uzs += revenue;
      } else {
        d.yandex_orders += e.sign;
        d.yandex_revenue_uzs += revenue;
      }
      channels[e.channel].orders += e.sign;
      channels[e.channel].revenue_uzs += revenue;
      for (const l of e.lines) {
        units += e.sign * l.qty;
        if (l.cost === null) withoutCost += e.sign * l.revenue;
        else {
          withCost += e.sign * l.revenue;
          cost += e.sign * l.cost;
        }
        const row = products.get(l.product_id) ?? { product_id: l.product_id, sku: l.sku, name_ru: l.name, qty: 0, revenue_uzs: 0 };
        row.qty += e.sign * l.qty;
        row.revenue_uzs += e.sign * l.revenue;
        products.set(l.product_id, row);
      }
    }
    const orders = channels.vitalo.orders + channels.yandex.orders;
    const revenue = channels.vitalo.revenue_uzs + channels.yandex.revenue_uzs;
    const top = [...products.values()].filter((r) => r.qty > 0).sort((a, b) => b.qty - a.qty || b.revenue_uzs - a.revenue_uzs).slice(0, 5);

    const [createdVitalo, createdYandex, byStatus, lowStock, attention, aiSpend] = await Promise.all([
      this.prisma.orders.count({ where: { is_test: false, created_at: { gte: fromTs } } }),
      this.prisma.marketplace_orders.count({ where: { is_test: false, created_at: { gte: fromTs } } }),
      this.prisma.orders.groupBy({ by: ['status'], where: { is_test: false }, _count: { _all: true } }),
      this.lowStock(),
      this.attention(to),
      viewer.ai ? this.aiSpend(now) : null,
    ]);

    return {
      days,
      from,
      to,
      sales: {
        orders,
        units,
        ...(viewer.revenue && { revenue_uzs: revenue, average_check_uzs: orders > 0 ? Math.round(revenue / orders) : 0 }),
        channels: {
          vitalo: { orders: channels.vitalo.orders, ...(viewer.revenue && { revenue_uzs: channels.vitalo.revenue_uzs }) },
          yandex: { orders: channels.yandex.orders, ...(viewer.revenue && { revenue_uzs: channels.yandex.revenue_uzs }) },
        },
        by_day: [...byDay.values()].map((d) => (viewer.revenue ? d : { day: d.day, vitalo_orders: d.vitalo_orders, yandex_orders: d.yandex_orders })),
      },
      ...(viewer.margin && {
        // gross margin on the cost of the jars sold; goods without a known cost are left out of the percent
        margin: {
          gross_uzs: withCost - cost,
          percent: withCost > 0 ? Math.round(((withCost - cost) / withCost) * 1000) / 10 : null,
          revenue_with_cost_uzs: withCost,
          revenue_without_cost_uzs: withoutCost,
        },
      }),
      orders_created: { vitalo: createdVitalo, yandex: createdYandex },
      statuses: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      top_products: top.map(({ revenue_uzs, ...r }) => ({ ...r, ...(viewer.revenue && { revenue_uzs }) })),
      low_stock: lowStock,
      attention,
      ...(aiSpend && { ai_spend: aiSpend }),
    };
  }

  /**
   * Available at or below the product's minimum; `incoming` — still expected from open purchases («уже едет»).
   * Минимум 0 = «за остатком не следим» (так у товаров «под заказ» и у новых без настройки) — такие товары
   * в список не попадают (аудит 10.11, п. 1.1).
   */
  private async lowStock() {
    const rows = await this.prisma.$queryRaw<{ id: string; sku: string; name_ru: string; min_stock: number; available: bigint; incoming: bigint }[]>`
      SELECT p.id, p.sku, p.name_ru, p.min_stock,
        COALESCE((SELECT SUM(i.actual_qty - i.reserved_qty) FROM inventory i WHERE i.product_id = p.id), 0) AS available,
        COALESCE((SELECT SUM(GREATEST(l.ordered_qty - l.cancelled_qty - l.received_qty, 0))
                  FROM purchase_lines l JOIN purchases pu ON pu.id = l.purchase_id
                  WHERE l.product_id = p.id AND pu.status = 'EXPECTED'), 0) AS incoming
      FROM products p
      WHERE p.status = 'active' AND p.min_stock > 0
        AND COALESCE((SELECT SUM(i.actual_qty - i.reserved_qty) FROM inventory i WHERE i.product_id = p.id), 0) <= p.min_stock
      ORDER BY available, p.name_ru
      LIMIT 20`;
    return rows.map((r) => ({ ...r, available: Number(r.available), incoming: Number(r.incoming) }));
  }

  /** «Требует внимания»: counters; each opens the list it counts. */
  private async attention(today: string) {
    const in90 = new Date(Date.parse(`${today}T00:00:00Z`) + 90 * 86_400_000);
    const dayAgo = new Date(Date.now() - 86_400_000);
    const [awaitingConfirmation, unitsAttention, yandexToShip, aiRed, compatPending, expiring, waitlist, yandexSync, staleReceiving, awaitingPayment] = await Promise.all([
      // «Я оплатил(а)» pressed, or cash on delivery waiting for the manager's call — the same filter as «Заказы»
      this.prisma.orders.count({
        where: {
          is_test: false,
          status: { in: ['new', 'awaiting_payment'] },
          payment_status: 'payment_pending',
          OR: [{ payments: { some: { manual: { some: { customer_confirmed_at: { not: null } } } } } }, { payments: { some: { method: { code: 'cod' } } } }],
        },
      }),
      this.prisma.orders.count({ where: { units_attention: { not: null }, status: { in: ['paid', 'picking'] } } }),
      // Yandex: not handed over yet and «Отгрузить до» is today or already passed
      this.prisma.marketplace_orders.count({ where: { is_test: false, status: { in: ['NEW', 'ASSEMBLED'] }, ship_by_date: { lte: new Date(`${today}T00:00:00Z`) } } }),
      this.prisma.ai_compat_answers.count({ where: { review: 'new', verdict: 'consult' } }),
      this.prisma.compat_requests.count({ where: { status: 'pending' } }),
      this.prisma.physical_units.count({ where: { status: { in: ['IN_STOCK', 'ASSIGNED'] }, expiry_date: { lt: in90 } } }),
      this.prisma.$queryRaw<{ products: bigint; people: bigint; in_stock: bigint; no_supply: bigint }[]>`
        SELECT COUNT(DISTINCT w.product_id) AS products, COUNT(*) AS people,
          COUNT(DISTINCT w.product_id) FILTER (WHERE COALESCE((SELECT SUM(i.actual_qty - i.reserved_qty) FROM inventory i WHERE i.product_id = w.product_id), 0) > 0) AS in_stock,
          -- people wait, nothing on the shelf and nothing in an open purchase («уже едет»): someone has to buy it
          COUNT(DISTINCT w.product_id) FILTER (
            WHERE COALESCE((SELECT SUM(i.actual_qty - i.reserved_qty) FROM inventory i WHERE i.product_id = w.product_id), 0) <= 0
              AND NOT EXISTS (SELECT 1 FROM purchase_lines l JOIN purchases pu ON pu.id = l.purchase_id
                              WHERE l.product_id = w.product_id AND pu.status = 'EXPECTED'
                                AND l.ordered_qty - l.cancelled_qty - l.received_qty > 0)
          ) AS no_supply
        FROM product_waitlist w
        WHERE w.notified_at IS NULL AND w.cancelled_at IS NULL`,
      // «Синхронизация Яндекса»: open «требует внимания» — the same filter as the page
      this.prisma.marketplace_external_orders.count({ where: { attention_kind: { not: null }, closed_at: null } }),
      // a receiving started more than a day ago and still not finished
      this.prisma.receiving_sessions.count({ where: { status: 'OPEN', created_at: { lt: dayAgo } } }),
      // Mini App: waiting for an online payment (the reserve is still on)
      this.prisma.orders.count({ where: { is_test: false, status: 'awaiting_payment' } }),
    ]);
    return {
      awaiting_confirmation: awaitingConfirmation,
      units_attention: unitsAttention,
      yandex_to_ship: yandexToShip,
      ai_red: aiRed,
      compat_pending: compatPending,
      expiring_units: expiring,
      waitlist: {
        products: Number(waitlist[0]?.products ?? 0),
        people: Number(waitlist[0]?.people ?? 0),
        in_stock: Number(waitlist[0]?.in_stock ?? 0),
        no_supply: Number(waitlist[0]?.no_supply ?? 0),
      },
      yandex_sync_attention: yandexSync,
      stale_receiving: staleReceiving,
      awaiting_payment: awaitingPayment,
    };
  }

  private async aiSpend(now: Date) {
    const [settings, spent] = await Promise.all([
      this.ai.settings(),
      this.prisma.ai_requests.aggregate({ _sum: { cost_usd: true }, where: { created_at: { gte: tashkentMonthStart(now) } } }),
    ]);
    return { month_usd: Math.round(Number(spent._sum.cost_usd ?? 0) * 100) / 100, budget_usd: settings.monthly_budget_usd };
  }
}

@ApiTags('staff: dashboard')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** Funnel for the period: unique customers per step and the share that reached it from the previous step. */
  @Get('funnel')
  @RequirePermission('dashboard.view')
  async funnel(@Query() q: FunnelQuery) {
    const from = periodStart(q.period);
    return { period: q.period, from, steps: await this.analytics.funnel(from), extra: await this.analytics.extraEvents(from) };
  }

  @Get()
  @RequirePermission('dashboard.view')
  get(@CurrentStaff() me: StaffContext, @Query() q: DashboardQuery) {
    const role = me.staff.role;
    return this.dashboard.get(q.days, { revenue: can(role, 'dashboard.revenue'), margin: can(role, 'costs.view'), ai: can(role, 'settings.manage') });
  }
}
