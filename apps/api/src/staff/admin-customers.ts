import { Body, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
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
}

export class BlockDto {
  @ApiProperty({ description: 'Причина (обязательно)' }) @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}

@Injectable()
export class AdminCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: CustomersQuery) {
    const or: Prisma.usersWhereInput[] = [];
    if (q.q) {
      const s = q.q.replace(/^@/, '');
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
    const where: Prisma.usersWhereInput = { ...(q.status && { status: q.status }), ...(or.length && { OR: or }) };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.users.count({ where }),
      this.prisma.users.findMany({ where, orderBy: { created_at: 'desc' }, skip: (q.page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    ]);
    const stats = await this.prisma.orders.groupBy({
      by: ['user_id'],
      where: { user_id: { in: rows.map((u) => u.id) }, status: { in: PAID_STATUSES } },
      _count: { _all: true },
      _sum: { total_uzs: true },
    });
    return {
      items: rows.map((u) => {
        const s = stats.find((x) => x.user_id === u.id);
        return { ...toUserProfile(u), status: u.status, paid_orders: s?._count._all ?? 0, spent_uzs: Number(s?._sum.total_uzs ?? 0n) };
      }),
      page: q.page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
    };
  }

  async get(id: string) {
    const u = await this.prisma.users.findUnique({
      where: { id },
      include: {
        addresses: { where: { deleted_at: null }, include: { region: true, city: true }, orderBy: { is_primary: 'desc' } },
        orders: { orderBy: { created_at: 'desc' }, take: 20 },
        bonus_account: true,
      },
    });
    if (!u) throw new NotFoundException('Customer not found');
    return {
      ...toUserProfile(u),
      status: u.status,
      bonus_balance_uzs: Number(u.bonus_account?.balance_uzs ?? 0n),
      addresses: u.addresses.map((a) => ({ id: a.id, label: a.label, region: a.region.name_ru, city: a.city.name_ru, address_text: a.address_text, is_primary: a.is_primary })),
      orders: u.orders.map((o) => ({ id: o.id, order_number: o.order_number, created_at: o.created_at, status: o.status, total_uzs: Number(o.total_uzs) })),
    };
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
