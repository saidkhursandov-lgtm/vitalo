import { Controller, Get, Injectable, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQuery } from '../catalog/catalog.dto';
import { tashkentDateString } from '../common/tashkent';
import { PrismaService } from '../prisma/prisma.service';
import { can } from './permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

const PAGE_SIZE = 30;
const bool = ({ value }: { value: unknown }) => value === true || value === 'true';

export class AllOrdersQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['all', 'vitalo', 'yandex'], default: 'all' }) @IsOptional() @IsIn(['all', 'vitalo', 'yandex']) channel: 'all' | 'vitalo' | 'yandex' = 'all';
  @ApiPropertyOptional({ description: 'true — «Отгрузить сегодня»: Mini App подтверждён/собирается, Яндекс «Отгрузить до» сегодня или раньше' })
  @IsOptional()
  @Transform(bool)
  ship_today?: boolean;
  @ApiPropertyOptional({ description: 'true — скрыть тестовые заказы' }) @IsOptional() @Transform(bool) hide_test?: boolean;
  @ApiPropertyOptional({ description: 'Номер заказа (VITALO или Яндекса)' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(64)
  q?: string;
}

/**
 * Генплан, этап 2 (аудит, п. 6): one list of the orders of both channels — Mini App and Yandex Market — with the
 * channel column and the common «Отгрузить сегодня». The cards stay separate (the data differ). An employee sees only
 * the channels they may open (orders.view / yandex.orders.view).
 */
@Injectable()
export class AllOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: AllOrdersQuery, allowed: { vitalo: boolean; yandex: boolean }, now = new Date()) {
    const page = q.page ?? 1;
    const today = tashkentDateString(now);
    const vitalo = allowed.vitalo && q.channel !== 'yandex';
    const yandex = allowed.yandex && q.channel !== 'vitalo';
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

    const vWhere = Prisma.sql`WHERE TRUE
      ${q.hide_test ? Prisma.sql`AND NOT o.is_test` : Prisma.empty}
      ${q.ship_today ? Prisma.sql`AND o.status IN ('paid', 'picking') AND NOT EXISTS (SELECT 1 FROM order_items ci WHERE ci.order_id = o.id AND ci.source = 'cross_border' AND ci.arrived_at IS NULL)` : Prisma.empty}
      ${like ? Prisma.sql`AND o.order_number ILIKE ${like}` : Prisma.empty}`;
    const yWhere = Prisma.sql`WHERE TRUE
      ${q.hide_test ? Prisma.sql`AND NOT m.is_test` : Prisma.empty}
      ${q.ship_today ? Prisma.sql`AND m.status IN ('NEW', 'ASSEMBLED') AND m.ship_by_date <= ${today}::date` : Prisma.empty}
      ${like ? Prisma.sql`AND m.external_number ILIKE ${like}` : Prisma.empty}`;
    const parts: Prisma.Sql[] = [];
    if (vitalo) parts.push(Prisma.sql`SELECT 'vitalo' AS channel, o.id, o.created_at FROM orders o ${vWhere}`);
    if (yandex) parts.push(Prisma.sql`SELECT 'yandex' AS channel, m.id, m.created_at FROM marketplace_orders m ${yWhere}`);
    if (!parts.length) return { items: [], page, page_size: PAGE_SIZE, total: 0, total_pages: 0, ship_today: 0 };
    const union = Prisma.join(parts, ' UNION ALL ');

    const [rows, [{ total }], shipToday] = await Promise.all([
      this.prisma.$queryRaw<{ channel: 'vitalo' | 'yandex'; id: string }[]>`
        SELECT channel, id FROM (${union}) x ORDER BY created_at DESC, id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      this.prisma.$queryRaw<{ total: bigint }[]>`SELECT COUNT(*) AS total FROM (${union}) x`,
      this.shipTodayCount(today, { vitalo: allowed.vitalo, yandex: allowed.yandex }),
    ]);

    const vIds = rows.filter((r) => r.channel === 'vitalo').map((r) => r.id);
    const yIds = rows.filter((r) => r.channel === 'yandex').map((r) => r.id);
    const [vRows, yRows] = await Promise.all([
      vIds.length
        ? this.prisma.orders.findMany({
            where: { id: { in: vIds } },
            include: { items: { select: { qty: true } }, payments: { select: { method: { select: { code: true } } }, take: 1 } },
          })
        : [],
      yIds.length ? this.prisma.marketplace_orders.findMany({ where: { id: { in: yIds } }, include: { lines: { select: { qty: true, unit_price_uzs: true } } } }) : [],
    ]);
    const day = (d: Date) => d.toISOString().slice(0, 10);

    const items = rows.map((r) => {
      if (r.channel === 'vitalo') {
        const o = vRows.find((x) => x.id === r.id)!;
        return {
          channel: 'vitalo' as const,
          id: o.id,
          number: o.order_number,
          created_at: o.created_at,
          status: o.status,
          payment_status: o.payment_status,
          payment_method: o.payments[0]?.method.code ?? null,
          customer: o.recipient_name,
          qty: o.items.reduce((s, i) => s + i.qty, 0),
          total_uzs: Number(o.total_uzs),
          ship_by: null,
          is_test: o.is_test,
        };
      }
      const m = yRows.find((x) => x.id === r.id)!;
      return {
        channel: 'yandex' as const,
        id: m.id,
        number: m.external_number,
        created_at: m.created_at,
        status: m.status,
        payment_status: null,
        payment_method: null,
        customer: m.customer_name,
        qty: m.lines.reduce((s, l) => s + l.qty, 0),
        total_uzs: m.lines.reduce((s, l) => s + Number(l.unit_price_uzs) * l.qty, 0),
        ship_by: m.ship_by_date ? { date: day(m.ship_by_date), time: m.ship_by_time } : null,
        is_test: m.is_test,
      };
    });
    const count = Number(total);
    return { items, page, page_size: PAGE_SIZE, total: count, total_pages: Math.ceil(count / PAGE_SIZE), ship_today: shipToday };
  }

  /** «Отгрузить сегодня» counter (both channels the employee may see), whatever the filters are. */
  private async shipTodayCount(today: string, allowed: { vitalo: boolean; yandex: boolean }) {
    const [v, y] = await Promise.all([
      allowed.vitalo ? this.prisma.orders.count({ where: { is_test: false, status: { in: ['paid', 'picking'] }, items: { none: { source: 'cross_border', arrived_at: null } } } }) : 0,
      allowed.yandex
        ? this.prisma.marketplace_orders.count({ where: { is_test: false, status: { in: ['NEW', 'ASSEMBLED'] }, ship_by_date: { lte: new Date(`${today}T00:00:00Z`) } } })
        : 0,
    ]);
    return v + y;
  }
}

@ApiTags('staff: orders')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/all-orders')
export class AllOrdersController {
  constructor(private readonly orders: AllOrdersService) {}

  @Get()
  @RequirePermission('orders.view', 'yandex.orders.view')
  list(@CurrentStaff() me: StaffContext, @Query() q: AllOrdersQuery) {
    return this.orders.list(q, { vitalo: can(me.staff.role, 'orders.view'), yandex: can(me.staff.role, 'yandex.orders.view') });
  }
}
