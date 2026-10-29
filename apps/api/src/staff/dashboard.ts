import { Controller, Get, Injectable, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { OrderStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { can } from './permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';
import { AnalyticsService } from '../analytics/analytics.module';

/** Orders that have been paid (revenue counts them by paid_at). */
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

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /** withRevenue = false (no dashboard.revenue, e.g. marketer): no revenue, average check or revenue per product. */
  async get(days: number, withRevenue = true) {
    const from = new Date(Date.now() - days * 86_400_000);
    // Stage 3: test orders are in no summary
    const paidInPeriod = { is_test: false, status: { in: PAID_STATUSES }, paid_at: { gte: from } };

    const [revenue, created, byStatus, top, lowStock] = await Promise.all([
      this.prisma.orders.aggregate({ where: paidInPeriod, _sum: { total_uzs: true }, _count: { _all: true } }),
      this.prisma.orders.count({ where: { is_test: false, created_at: { gte: from } } }),
      this.prisma.orders.groupBy({ by: ['status'], where: { is_test: false }, _count: { _all: true } }),
      this.prisma.order_items.groupBy({
        by: ['product_id'],
        where: { order: paidInPeriod },
        _sum: { qty: true, line_total_uzs: true },
        orderBy: { _sum: { qty: 'desc' } },
        take: 5,
      }),
      // available = actual - reserved, summed over warehouses; "low" = at or below the product's min_stock
      this.prisma.$queryRaw<{ id: string; sku: string; name_ru: string; min_stock: number; available: bigint }[]>`
        SELECT p.id, p.sku, p.name_ru, p.min_stock, COALESCE(SUM(i.actual_qty - i.reserved_qty), 0) AS available
        FROM products p LEFT JOIN inventory i ON i.product_id = p.id
        WHERE p.status = 'active'
        GROUP BY p.id
        HAVING COALESCE(SUM(i.actual_qty - i.reserved_qty), 0) <= p.min_stock
        ORDER BY available, p.name_ru
        LIMIT 20`,
    ]);

    const names = await this.prisma.products.findMany({
      where: { id: { in: top.map((t) => t.product_id) } },
      select: { id: true, sku: true, name_ru: true },
    });
    const revenueUzs = Number(revenue._sum.total_uzs ?? 0n);
    const paidCount = revenue._count._all;

    return {
      days,
      ...(withRevenue && { revenue_uzs: revenueUzs }),
      paid_orders: paidCount,
      orders_created: created,
      ...(withRevenue && { average_check_uzs: paidCount ? Math.round(revenueUzs / paidCount) : 0 }),
      statuses: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      top_products: top.map((t) => {
        const p = names.find((n) => n.id === t.product_id);
        return {
          product_id: t.product_id,
          sku: p?.sku,
          name_ru: p?.name_ru,
          qty: t._sum.qty ?? 0,
          ...(withRevenue && { revenue_uzs: Number(t._sum.line_total_uzs ?? 0n) }),
        };
      }),
      low_stock: lowStock.map((r) => ({ ...r, available: Number(r.available) })),
    };
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
    return this.dashboard.get(q.days, can(me.staff.role, 'dashboard.revenue'));
  }
}
