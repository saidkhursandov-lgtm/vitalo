import { Controller, Get, Injectable, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { MarketplaceOrderStatus, OrderStatus, Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PageQuery } from '../catalog/catalog.dto';
import { tashkentDateString } from '../common/tashkent';
import { PrismaService } from '../prisma/prisma.service';
import { can } from './permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

const PAGE_SIZE = 30;
const bool = ({ value }: { value: unknown }) => value === true || value === 'true';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VITALO_STATUSES: string[] = Object.values(OrderStatus);
const YANDEX_STATUSES: string[] = Object.values(MarketplaceOrderStatus);
const list = ({ value }: { value: unknown }) =>
  (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);

export class AllOrdersQuery extends PageQuery {
  @ApiPropertyOptional({ enum: ['all', 'vitalo', 'yandex'], default: 'all' }) @IsOptional() @IsIn(['all', 'vitalo', 'yandex']) channel: 'all' | 'vitalo' | 'yandex' = 'all';
  @ApiPropertyOptional({ description: 'true — «Отгрузить сегодня»: Mini App подтверждён/собирается, Яндекс «Отгрузить до» сегодня или раньше' })
  @IsOptional()
  @Transform(bool)
  ship_today?: boolean;
  @ApiPropertyOptional({ description: 'true — скрыть тестовые заказы' }) @IsOptional() @Transform(bool) hide_test?: boolean;
  @ApiPropertyOptional({ description: 'Номер заказа (VITALO или Яндекса), телефон, имя получателя или username (аудит 2.1)' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(64)
  q?: string;
  @ApiPropertyOptional({ description: 'Статусы через запятую: Mini App (paid, cancelled …) и/или Яндекса (NEW, DELIVERED …)', example: 'awaiting_payment,NEW' })
  @IsOptional()
  @Transform(list)
  @IsArray()
  @IsIn([...VITALO_STATUSES, ...YANDEX_STATUSES], { each: true })
  status?: string[];
  @ApiPropertyOptional({ description: 'Способ оплаты (код: payme, cod, card_transfer …) — только заказы Mini App' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z_]{2,32}$/)
  payment_method?: string;
  @ApiPropertyOptional({ example: '2026-11-01', description: 'Создан с этого дня (по Ташкенту)' }) @IsOptional() @Matches(DATE) date_from?: string;
  @ApiPropertyOptional({ example: '2026-11-30', description: 'Создан по этот день включительно (по Ташкенту)' }) @IsOptional() @Matches(DATE) date_to?: string;
  @ApiPropertyOptional({ enum: [30, 100], default: 30 }) @IsOptional() @Type(() => Number) @IsIn([30, 100]) page_size?: number;
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
    const size = q.page_size ?? PAGE_SIZE;
    const today = tashkentDateString(now);
    // аудит 2.1: the statuses of one channel only (or a payment method, Mini App only) leave the other channel out
    const vStatuses = (q.status ?? []).filter((s) => VITALO_STATUSES.includes(s));
    const yStatuses = (q.status ?? []).filter((s) => YANDEX_STATUSES.includes(s));
    const byStatus = (q.status ?? []).length > 0;
    const vitalo = allowed.vitalo && q.channel !== 'yandex' && (!byStatus || vStatuses.length > 0);
    const yandex = allowed.yandex && q.channel !== 'vitalo' && (!byStatus || yStatuses.length > 0) && !q.payment_method;
    const escape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
    const like = q.q ? `%${escape(q.q)}%` : null;
    // a phone is typed in any form (+998 93 …, 93-123): compare the digits only, from 4 digits on
    const digits = q.q?.replace(/\D/g, '') ?? '';
    const phone = digits.length >= 4 ? `%${digits}%` : null;
    // the period by the day of creation in Tashkent (created_at is UTC without a zone; Tashkent is UTC+5 all year)
    const period = (col: Prisma.Sql) => Prisma.sql`
      ${q.date_from ? Prisma.sql`AND (${col} + interval '5 hours')::date >= ${q.date_from}::date` : Prisma.empty}
      ${q.date_to ? Prisma.sql`AND (${col} + interval '5 hours')::date <= ${q.date_to}::date` : Prisma.empty}`;

    const vWhere = Prisma.sql`WHERE TRUE
      ${q.hide_test ? Prisma.sql`AND NOT o.is_test` : Prisma.empty}
      ${q.ship_today ? Prisma.sql`AND o.status IN ('paid', 'picking') AND NOT EXISTS (SELECT 1 FROM order_items ci WHERE ci.order_id = o.id AND ci.source = 'cross_border' AND ci.arrived_at IS NULL)` : Prisma.empty}
      ${vStatuses.length ? Prisma.sql`AND o.status::text = ANY(${vStatuses})` : Prisma.empty}
      ${q.payment_method ? Prisma.sql`AND EXISTS (SELECT 1 FROM payments pa JOIN payment_methods pm ON pm.id = pa.payment_method_id WHERE pa.order_id = o.id AND pm.code = ${q.payment_method})` : Prisma.empty}
      ${period(Prisma.sql`o.created_at`)}
      ${
        like
          ? Prisma.sql`AND (o.order_number ILIKE ${like} OR o.recipient_name ILIKE ${like}
              OR EXISTS (SELECT 1 FROM users u WHERE u.id = o.user_id AND (u.username ILIKE ${like} OR u.first_name ILIKE ${like} OR u.last_name ILIKE ${like}
                ${phone ? Prisma.sql`OR regexp_replace(coalesce(u.phone, ''), '\\D', '', 'g') LIKE ${phone}` : Prisma.empty}))
              ${phone ? Prisma.sql`OR regexp_replace(o.recipient_phone, '\\D', '', 'g') LIKE ${phone}` : Prisma.empty})`
          : Prisma.empty
      }`;
    const yWhere = Prisma.sql`WHERE TRUE
      ${q.hide_test ? Prisma.sql`AND NOT m.is_test` : Prisma.empty}
      ${q.ship_today ? Prisma.sql`AND m.status IN ('NEW', 'ASSEMBLED') AND m.ship_by_date <= ${today}::date` : Prisma.empty}
      ${yStatuses.length ? Prisma.sql`AND m.status::text = ANY(${yStatuses})` : Prisma.empty}
      ${period(Prisma.sql`m.created_at`)}
      ${like ? Prisma.sql`AND (m.external_number ILIKE ${like} OR m.customer_name ILIKE ${like})` : Prisma.empty}`;
    const parts: Prisma.Sql[] = [];
    if (vitalo) parts.push(Prisma.sql`SELECT 'vitalo' AS channel, o.id, o.created_at, o.total_uzs::numeric AS total_uzs FROM orders o ${vWhere}`);
    if (yandex)
      parts.push(Prisma.sql`SELECT 'yandex' AS channel, m.id, m.created_at,
        COALESCE((SELECT SUM(l.unit_price_uzs * l.qty) FROM marketplace_order_lines l WHERE l.order_id = m.id), 0)::numeric AS total_uzs
        FROM marketplace_orders m ${yWhere}`);
    if (!parts.length) return { items: [], page, page_size: size, total: 0, total_pages: 0, total_sum_uzs: 0, ship_today: 0 };
    const union = Prisma.join(parts, ' UNION ALL ');

    const [rows, [{ total, sum }], shipToday] = await Promise.all([
      this.prisma.$queryRaw<{ channel: 'vitalo' | 'yandex'; id: string }[]>`
        SELECT channel, id FROM (${union}) x ORDER BY created_at DESC, id LIMIT ${size} OFFSET ${(page - 1) * size}`,
      this.prisma.$queryRaw<{ total: bigint; sum: Prisma.Decimal | null }[]>`SELECT COUNT(*) AS total, SUM(total_uzs) AS sum FROM (${union}) x`,
      this.shipTodayCount(today, { vitalo: allowed.vitalo, yandex: allowed.yandex }),
    ]);

    const vIds = rows.filter((r) => r.channel === 'vitalo').map((r) => r.id);
    const yIds = rows.filter((r) => r.channel === 'yandex').map((r) => r.id);
    // Аудит 10.11, п. 1.6: who cancelled — the last «→ cancelled» record of the history (stored as is, translated in the admin)
    const cancels = vIds.length
      ? await this.prisma.$queryRaw<{ order_id: string; changed_by_type: 'system' | 'staff' | 'customer'; reason: string | null; staff_name: string | null }[]>`
          SELECT DISTINCT ON (h.order_id) h.order_id, h.changed_by_type, h.reason, s.name AS staff_name
          FROM order_status_history h
          LEFT JOIN staff_users s ON s.id = h.changed_by_id AND h.changed_by_type = 'staff'
          WHERE h.order_id::text = ANY(${vIds}) AND h.to_status = 'cancelled'
          ORDER BY h.order_id, h.created_at DESC`
      : [];
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
          cancel: o.status === 'cancelled' ? cancelOf(cancels.find((c) => c.order_id === o.id)) : null,
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
        cancel: m.status === 'CANCELLED' ? { by: 'yandex' as const, reason: m.cancel_reason, staff_name: null } : null,
      };
    });
    const count = Number(total);
    // аудит 2.1: the totals of the whole filter, not of the page
    return { items, page, page_size: size, total: count, total_pages: Math.ceil(count / size), total_sum_uzs: Number(sum ?? 0), ship_today: shipToday };
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

/** Who cancelled a Mini App order: system (e.g. the reserve expired), the customer or an employee (with the name). */
function cancelOf(h: { changed_by_type: 'system' | 'staff' | 'customer'; reason: string | null; staff_name: string | null } | undefined) {
  if (!h) return null;
  return { by: h.changed_by_type, reason: h.reason, staff_name: h.staff_name };
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
