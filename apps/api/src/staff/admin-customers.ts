import { Body, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { BonusService } from '../bonus/bonus.service';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma, UserStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { toUserProfile } from '../auth/auth.types';
import { PageQuery } from '../catalog/catalog.dto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { PAID_STATUSES } from './dashboard';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

const PAGE_SIZE = 50;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CustomersQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'Имя, @username, телефон или Telegram ID' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional({ enum: UserStatus }) @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @ApiPropertyOptional({ description: 'true — скрыть тестовых клиентов (аудит 10.11, п. 1.5)' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  hide_test?: boolean;
}

/** Аудит 4.1: a staff note about the customer. */
export class NoteDto {
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(2000) text!: string;
}

/** Аудит 4.1: «𝓐𝓷𝓪» and «Ana» are the same name for the search (NFKC folds styled Unicode letters). */
export const nfkc = (s: string) => s.normalize('NFKC');

export class BlockDto {
  @ApiProperty({ description: 'Причина (обязательно)' }) @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}

@Injectable()
export class AdminCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bonus: BonusService,
  ) {}

  async list(q: CustomersQuery) {
    const or: Prisma.usersWhereInput[] = [];
    if (q.q) {
      const s = nfkc(q.q.replace(/^@/, ''));
      // names written with styled Unicode letters: compared after NFKC on both sides (nothing is changed in the base)
      const styled = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM users
        WHERE normalize(first_name, NFKC) ILIKE ${`%${s}%`} OR normalize(coalesce(last_name, ''), NFKC) ILIKE ${`%${s}%`}
        LIMIT 500`;
      if (styled.length) or.push({ id: { in: styled.map((r) => r.id) } });
      or.push(
        { first_name: { contains: s, mode: 'insensitive' } },
        { last_name: { contains: s, mode: 'insensitive' } },
        { username: { contains: s, mode: 'insensitive' } },
      );
      const digits = s.replace(/\D/g, '');
      if (digits.length >= 4) {
        or.push({ phone: { contains: digits } }, { orders: { some: { recipient_phone: { contains: digits } } } });
        if (/^\d+$/.test(s)) or.push({ telegram_user_id: BigInt(s) });
      }
    }
    const where: Prisma.usersWhereInput = { ...(q.status && { status: q.status }), ...(q.hide_test && { is_test: false }), ...(or.length && { OR: or }) };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.users.count({ where }),
      this.prisma.users.findMany({ where, orderBy: { created_at: 'desc' }, skip: (q.page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    ]);
    const ids = rows.map((u) => u.id);
    const [stats, all, active] = await Promise.all([
      this.prisma.orders.groupBy({
        by: ['user_id'],
        where: { user_id: { in: ids }, status: { in: PAID_STATUSES } },
        _count: { _all: true },
        _sum: { total_uzs: true },
      }),
      // аудит 4.1: every order, cancelled ones too — «0 оплачено» alone hid that the customer did order
      this.prisma.orders.groupBy({ by: ['user_id'], where: { user_id: { in: ids } }, _count: { _all: true } }),
      this.lastActivity(ids),
    ]);
    return {
      items: rows.map((u) => {
        const s = stats.find((x) => x.user_id === u.id);
        return {
          ...toUserProfile(u),
          status: u.status,
          is_test: u.is_test,
          paid_orders: s?._count._all ?? 0,
          spent_uzs: Number(s?._sum.total_uzs ?? 0n),
          total_orders: all.find((x) => x.user_id === u.id)?._count._all ?? 0,
          last_activity_at: active.get(u.id) ?? u.created_at,
        };
      }),
      page: q.page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
    };
  }

  /** The last thing the customer did: an app event, a sign-in or an order — whichever is newest. */
  private async lastActivity(ids: string[]): Promise<Map<string, Date>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.$queryRaw<{ user_id: string; at: Date }[]>`
      SELECT user_id, MAX(at) AS at FROM (
        SELECT user_id, MAX(created_at) AS at FROM analytics_events WHERE user_id::text = ANY(${ids}) GROUP BY user_id
        UNION ALL SELECT user_id, MAX(created_at) FROM user_sessions WHERE user_id::text = ANY(${ids}) GROUP BY user_id
        UNION ALL SELECT user_id, MAX(created_at) FROM orders WHERE user_id::text = ANY(${ids}) GROUP BY user_id
      ) t GROUP BY user_id`;
    return new Map(rows.map((r) => [r.user_id, r.at]));
  }

  /**
   * Аудит 4.1: the customer card — orders (all, with totals), requests to support, compatibility questions (no comment:
   * it may hold health data, it stays in «Совместимость» for admins and specialists), staff notes.
   */
  async get(id: string) {
    const u = await this.prisma.users.findUnique({
      where: { id },
      include: {
        addresses: { where: { deleted_at: null }, include: { region: true, city: true }, orderBy: { is_primary: 'desc' } },
        orders: { orderBy: { created_at: 'desc' }, take: 50 },
        bonus_account: true,
        support_threads: { orderBy: { last_message_at: 'desc' }, take: 20 },
        compat_requests: { orderBy: { created_at: 'desc' }, take: 20, select: { id: true, created_at: true, status: true, verdict: true, source: true, items: true } },
        notes: { orderBy: { created_at: 'desc' }, include: { staff: { select: { name: true } } } },
      },
    });
    if (!u) throw new NotFoundException('Customer not found');
    const [paid, total, active] = await Promise.all([
      this.prisma.orders.aggregate({ where: { user_id: id, status: { in: PAID_STATUSES } }, _count: { _all: true }, _sum: { total_uzs: true } }),
      this.prisma.orders.count({ where: { user_id: id } }),
      this.lastActivity([id]),
    ]);
    return {
      ...toUserProfile(u),
      status: u.status,
      is_test: u.is_test,
      bonus_balance_uzs: Number(u.bonus_account?.balance_uzs ?? 0n),
      // 3.10-А: when the balance burns and the last operations
      bonus: { ...(await this.bonus.account(id)), history: await this.bonus.history(id, { limit: 20 }) },
      addresses: u.addresses.map((a) => ({ id: a.id, label: a.label, region: a.region.name_ru, city: a.city.name_ru, address_text: a.address_text, is_primary: a.is_primary })),
      orders: u.orders.map((o) => ({ id: o.id, order_number: o.order_number, created_at: o.created_at, status: o.status, total_uzs: Number(o.total_uzs), is_test: o.is_test })),
      total_orders: total,
      paid_orders: paid._count._all,
      spent_uzs: Number(paid._sum.total_uzs ?? 0n),
      last_activity_at: active.get(id) ?? u.created_at,
      marketing_opt_in: u.marketing_opt_in,
      created_at: u.created_at,
      support: u.support_threads.map((t) => ({ id: t.id, number: t.number, topic: t.topic, status: t.status, last_message_at: t.last_message_at })),
      compat: u.compat_requests.map((c) => ({
        id: c.id,
        created_at: c.created_at,
        status: c.status,
        verdict: c.verdict,
        source: c.source,
        products: Array.isArray(c.items) ? (c.items as { name_ru?: string }[]).map((i) => i.name_ru ?? '').filter(Boolean) : [],
      })),
      notes: u.notes.map((n) => ({ id: n.id, text: n.text, created_at: n.created_at, staff_name: n.staff.name })),
    };
  }

  async addNote(staffId: string, id: string, text: string) {
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.users.findUnique({ where: { id }, select: { id: true } });
      if (!u) throw new NotFoundException('Customer not found');
      const n = await tx.customer_notes.create({ data: { user_id: id, staff_user_id: staffId, text } });
      await this.audit.log({ staffId, action: 'customer.note_added', entityType: 'user', entityId: id, after: { note_id: n.id, text } }, tx);
    });
    return this.get(id);
  }

  /** Blocked customers lose their sessions immediately and cannot log in again. */
  async setBlocked(staffId: string, id: string, blocked: boolean, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const u = await tx.users.findUnique({ where: { id } });
      if (!u) throw new NotFoundException('Customer not found');
      const status = blocked ? 'blocked' : 'active';
      if (u.status === status) return;
      await tx.users.update({ where: { id }, data: { status } });
      if (blocked) await tx.user_sessions.updateMany({ where: { user_id: id, revoked_at: null }, data: { revoked_at: new Date() } });
      await this.audit.log(
        { staffId, action: blocked ? 'customer.blocked' : 'customer.unblocked', entityType: 'user', entityId: id, before: { status: u.status }, after: { status, reason } },
        tx,
      );
    });
    return this.get(id);
  }
}

@ApiTags('staff: customers')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/customers')
export class AdminCustomersController {
  constructor(private readonly customers: AdminCustomersService) {}

  @Get()
  @RequirePermission('customers.view')
  list(@Query() q: CustomersQuery) {
    return this.customers.list(q);
  }

  @Get(':id')
  @RequirePermission('customers.view')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.customers.get(id);
  }

  /** Аудит 4.1: whoever sees the customer may leave a note (managers work with customers). */
  @Post(':id/notes')
  @HttpCode(200)
  @RequirePermission('customers.view')
  note(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: NoteDto) {
    return this.customers.addNote(me.staff.id, id, dto.text);
  }

  @Post(':id/block')
  @HttpCode(200)
  @RequirePermission('customers.block')
  block(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: BlockDto) {
    return this.customers.setBlocked(me.staff.id, id, true, dto.reason);
  }

  @Post(':id/unblock')
  @HttpCode(200)
  @RequirePermission('customers.block')
  unblock(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: BlockDto) {
    return this.customers.setBlocked(me.staff.id, id, false, dto.reason);
  }
}
