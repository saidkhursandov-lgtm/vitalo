import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { OrderStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { TelegramLoginDto } from '../auth/auth.controller';
import { PageQuery } from '../catalog/catalog.dto';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { orderViewInclude, toOrderView } from '../orders/order-view';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentStaff, StaffAuthService, StaffContext, StaffGuard, StaffRoles } from './staff-auth';

const PAGE_SIZE = 50;

export class StaffOrdersQuery extends PageQuery {
  @ApiPropertyOptional({ enum: OrderStatus }) @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;

  @ApiPropertyOptional({ description: 'true — только заказы, где клиент нажал «Я оплатил», а оплата ещё не подтверждена' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  awaiting_confirmation?: boolean;
}

export class ConfirmPaymentDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) comment?: string;
}

@ApiTags('staff')
@Controller('staff/auth')
export class StaffAuthController {
  constructor(private readonly auth: StaffAuthService) {}

  @Post('telegram')
  @HttpCode(200)
  login(@Body() dto: TelegramLoginDto) {
    return this.auth.login(dto.initData);
  }
}

@ApiTags('staff')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@StaffRoles('manager')
@Controller('staff/orders')
export class StaffOrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}

  @Get()
  async list(@Query() q: StaffOrdersQuery) {
    const where = {
      ...(q.status && { status: q.status }),
      ...(q.awaiting_confirmation && {
        payment_status: 'payment_pending' as const,
        status: { in: ['new', 'awaiting_payment'] as OrderStatus[] },
        payments: { some: { manual: { some: { customer_confirmed_at: { not: null } } } } },
      }),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.orders.count({ where }),
      this.prisma.orders.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (q.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { user: true },
      }),
    ]);
    return {
      items: rows.map((o) => ({
        id: o.id,
        order_number: o.order_number,
        created_at: o.created_at,
        status: o.status,
        payment_status: o.payment_status,
        total_uzs: Number(o.total_uzs),
        reserved_until: o.reserved_until,
        customer: { id: o.user.id, name: [o.user.first_name, o.user.last_name].filter(Boolean).join(' '), username: o.user.username },
        recipient_phone: o.recipient_phone,
      })),
      page: q.page,
      page_size: PAGE_SIZE,
      total,
    };
  }

  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const order = await this.prisma.orders.findUnique({ where: { id }, include: orderViewInclude });
    if (!order) throw new NotFoundException('Order not found');
    return toOrderView(order);
  }

  /** Manager confirms the bank transfer: stock reservation -> write-off, order -> Paid. Idempotent. */
  @Post(':id/confirm-payment')
  @HttpCode(200)
  async confirmPayment(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ConfirmPaymentDto) {
    return this.prisma.$transaction(
      async (tx) => {
        const order = await this.lifecycle.lockOrder(tx, id);
        await this.lifecycle.confirmBankTransfer(tx, order, me.staff.id, dto.comment);
        return toOrderView(await tx.orders.findUniqueOrThrow({ where: { id }, include: orderViewInclude }));
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  }
}
