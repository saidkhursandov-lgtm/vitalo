import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { PageQuery } from '../catalog/catalog.dto';
import { DeliveryService } from '../delivery/delivery.service';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { OrderUnitsService } from '../orders/order-units.service';
import { orderViewInclude, toOrderView } from '../orders/order-view';
import { normalizeUzPhone } from '../orders/orders.dto';
import { PrismaService } from '../prisma/prisma.service';
import { auditJson, AuditService } from './audit.service';
import { can, type Permission } from './permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';
import { AnalyticsService } from '../analytics/analytics.module';

const PAGE_SIZE = 50;
const TX = { maxWait: 10_000, timeout: 20_000 };
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Forward steps after payment and who may make them (Master TZ §11, Flow §10). */
export const FULFILMENT_STEPS: Partial<Record<OrderStatus, { next: OrderStatus; permission: Permission }>> = {
  paid: { next: 'picking', permission: 'orders.fulfil' },
  picking: { next: 'handed_to_delivery', permission: 'orders.fulfil' },
  handed_to_delivery: { next: 'in_transit', permission: 'orders.deliver' },
  in_transit: { next: 'delivered', permission: 'orders.deliver' },
};

/** Editing is allowed only before handover; after it the order is locked (Master TZ §11). */
export const EDITABLE_STATUSES: OrderStatus[] = ['new', 'awaiting_payment', 'paid', 'picking'];

/** «Нужно внимание склада» matters while the order is paid and not handed over yet. */
const ATTENTION_STATUSES: OrderStatus[] = ['paid', 'picking'];

export class StaffOrdersQuery extends PageQuery {
  @ApiPropertyOptional({ enum: OrderStatus }) @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
  @ApiPropertyOptional({ enum: PaymentStatus }) @IsOptional() @IsEnum(PaymentStatus) payment_status?: PaymentStatus;
  @ApiPropertyOptional({ description: 'Номер заказа, телефон или имя' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional({ example: '2026-10-01' }) @IsOptional() @IsDateString() date_from?: string;
  @ApiPropertyOptional({ example: '2026-10-31' }) @IsOptional() @IsDateString() date_to?: string;

  @ApiPropertyOptional({ description: 'true — клиент нажал «Я оплатил», оплата не подтверждена' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  awaiting_confirmation?: boolean;

  @ApiPropertyOptional({ description: 'true — скрыть тестовые заказы' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  hide_test?: boolean;

  @ApiPropertyOptional({ description: 'true — только «Нужно внимание склада» (оплачен, банки не закреплены)' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  units_attention?: boolean;
}

export class ConfirmPaymentDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) comment?: string;
}

export class ChangeStatusDto {
  @ApiProperty({ enum: ['picking', 'handed_to_delivery', 'in_transit', 'delivered'] })
  @IsIn(['picking', 'handed_to_delivery', 'in_transit', 'delivered'])
  status!: OrderStatus;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) comment?: string;
}

export class PickUnitDto {
  @ApiProperty({ example: 'V-000184' }) @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(40) physical_id!: string;
  @ApiPropertyOptional({ description: 'Причина, если выбрана не самая старая банка (мягкий FEFO)' })
  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(300) fefo_reason?: string;
}

export class StaffCancelDto {
  @ApiProperty({ description: 'Причина отмены (обязательно)' }) @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}

export class EditOrderDto {
  @ApiProperty({ description: 'Почему меняем (попадает в журнал)' }) @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) recipient_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => normalizeUzPhone(value))
  @Matches(/^\+998\d{9}$/, { message: 'recipient_phone must be +998XXXXXXXXX' })
  recipient_phone?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() region_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() city_id?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(500) address_text?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500) customer_comment?: string;
}

@Injectable()
export class AdminOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly delivery: DeliveryService,
    private readonly audit: AuditService,
    private readonly analytics: AnalyticsService,
    private readonly units: OrderUnitsService,
  ) {}

  async list(q: StaffOrdersQuery) {
    const ATTENTION: Prisma.ordersWhereInput = { units_attention: { not: null }, status: { in: ATTENTION_STATUSES } };
    const and: Prisma.ordersWhereInput[] = [];
    if (q.status) and.push({ status: q.status });
    if (q.payment_status) and.push({ payment_status: q.payment_status });
    if (q.date_from) and.push({ created_at: { gte: new Date(`${q.date_from}T00:00:00+05:00`) } });
    if (q.date_to) and.push({ created_at: { lt: new Date(new Date(`${q.date_to}T00:00:00+05:00`).getTime() + 86_400_000) } });
    if (q.awaiting_confirmation) {
      and.push({
        status: { in: ['new', 'awaiting_payment'] },
        payment_status: 'payment_pending',
        payments: { some: { manual: { some: { customer_confirmed_at: { not: null } } } } },
      });
    }
    if (q.hide_test) and.push({ is_test: false });
    if (q.units_attention) and.push(ATTENTION);
    if (q.q) {
      const digits = q.q.replace(/\D/g, '');
      and.push({
        OR: [
          { order_number: { contains: q.q, mode: 'insensitive' } },
          { recipient_name: { contains: q.q, mode: 'insensitive' } },
          { user: { first_name: { contains: q.q, mode: 'insensitive' } } },
          ...(digits.length >= 4 ? [{ recipient_phone: { contains: digits } }] : []),
        ],
      });
    }
    const where: Prisma.ordersWhereInput = { AND: and };
    const [attention, total, rows] = await this.prisma.$transaction([
      this.prisma.orders.count({ where: ATTENTION }),
      this.prisma.orders.count({ where }),
      this.prisma.orders.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (q.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { user: true, payments: { include: { manual: true } } },
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
        is_test: o.is_test,
        units_attention: ATTENTION_STATUSES.includes(o.status) ? o.units_attention : null,
        reserved_until: o.reserved_until,
        customer_reported_paid: o.payments.some((p) => p.manual.some((m) => m.customer_confirmed_at)),
        customer: { id: o.user.id, name: [o.user.first_name, o.user.last_name].filter(Boolean).join(' '), username: o.user.username },
        recipient_name: o.recipient_name,
        recipient_phone: o.recipient_phone,
      })),
      // Stage 3: how many orders wait for the warehouse now (counter above the list, whatever the filters are)
      attention_count: attention,
      page: q.page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
    };
  }

  async get(id: string, staff: StaffContext) {
    const order = await this.prisma.orders.findUnique({
      where: { id },
      include: {
        ...orderViewInclude,
        user: true,
        edits: { orderBy: { created_at: 'desc' }, include: { staff: true } },
        tasks: { orderBy: { created_at: 'desc' } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    const step = FULFILMENT_STEPS[order.status];
    const role = staff.staff.role;
    return {
      ...toOrderView(order),
      is_test: order.is_test,
      // Stage 3: what the delivery really cost us — admin only
      ...(can(role, 'finance.manage') && { finance: { own_delivery_cost_uzs: Number(order.own_delivery_cost_uzs) } }),
      customer: {
        id: order.user.id,
        name: [order.user.first_name, order.user.last_name].filter(Boolean).join(' '),
        username: order.user.username,
        telegram_user_id: Number(order.user.telegram_user_id),
        status: order.user.status,
      },
      edits: order.edits.map((e) => ({
        reason: e.reason,
        before: e.before_json,
        after: e.after_json,
        staff_name: e.staff.name,
        created_at: e.created_at,
      })),
      tasks: order.tasks.map((t) => ({ type: t.type, status: t.status, note: t.note, created_at: t.created_at })),
      // Stage 2E «Сборка»: units of unit-tracked lines (null when the order has none); costs and profit only with costs.view
      assembly: await this.units.view(this.prisma, id, can(role, 'costs.view')),
      // What the current employee may do now (the server re-checks on every action).
      actions: {
        confirm_payment: can(role, 'orders.payment') && order.payment_status === 'payment_pending' && ['new', 'awaiting_payment'].includes(order.status),
        next_status: step && can(role, step.permission) ? step.next : null,
        cancel: can(role, 'orders.cancel') && EDITABLE_STATUSES.includes(order.status),
        edit: can(role, 'orders.edit') && EDITABLE_STATUSES.includes(order.status),
        locked: !EDITABLE_STATUSES.includes(order.status) && order.status !== 'cancelled',
        units: can(role, 'orders.units') && (order.status === 'paid' || order.status === 'picking'),
        return_order: can(role, 'orders.units') && ['handed_to_delivery', 'in_transit', 'delivered'].includes(order.status),
      },
    };
  }

  async confirmPayment(staff: StaffContext, id: string, comment?: string) {
    let confirmedFor: string | null = null;
    const view = await this.inOrderTx(id, async (tx, order) => {
      if ((await this.lifecycle.confirmBankTransfer(tx, order, staff.staff.id, comment)) === 'paid') confirmedFor = order.user_id;
    });
    if (confirmedFor) await this.analytics.track(confirmedFor, 'payment_confirmed', { order_id: id });
    return view;
  }

  /** One step forward along the state machine; jumping or going back is refused. */
  changeStatus(staff: StaffContext, id: string, to: OrderStatus, comment?: string) {
    return this.inOrderTx(id, async (tx, order) => {
      const step = FULFILMENT_STEPS[order.status];
      if (!step || step.next !== to) {
        throw new ConflictException({ code: 'INVALID_STATUS_TRANSITION', message: `Cannot move order from ${order.status} to ${to}` });
      }
      if (!can(staff.staff.role, step.permission)) {
        throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE', message: `Role ${staff.staff.role} cannot set ${to}` });
      }
      // Stage 2E: the units of unit-tracked lines move with the order (and the stock is written off at the handover)
      if (to === 'handed_to_delivery') await this.units.handOver(tx, order, staff.staff.id);
      if (to === 'delivered') await this.units.deliver(tx, order, staff.staff.id);
      await tx.orders.update({ where: { id }, data: { status: to, ...(to === 'delivered' && { delivered_at: new Date() }) } });
      await this.lifecycle.addHistory(tx, id, order.status, to, { type: 'staff', id: staff.staff.id }, comment);
      await this.audit.log(
        { staffId: staff.staff.id, action: 'order.status_changed', entityType: 'order', entityId: id, before: { status: order.status }, after: { status: to, comment } },
        tx,
      );
    });
  }

  /** Before handover only. Unpaid: reservation released. Paid: stock returned + refund task. */
  cancel(staff: StaffContext, id: string, reason: string) {
    return this.inOrderTx(id, async (tx, order) => {
      if (order.status === 'cancelled') return;
      if (!EDITABLE_STATUSES.includes(order.status)) {
        throw new ConflictException({ code: 'ORDER_LOCKED', message: 'After handover the order can only be cancelled via a cancel request' });
      }
      if (order.status === 'new' || order.status === 'awaiting_payment') {
        await this.lifecycle.cancelUnpaid(tx, order, { type: 'staff', id: staff.staff.id }, reason);
      } else {
        await this.lifecycle.cancelPaid(tx, order, staff.staff.id, reason);
      }
      await this.audit.log(
        { staffId: staff.staff.id, action: 'order.cancelled', entityType: 'order', entityId: id, before: { status: order.status }, after: { status: 'cancelled', reason } },
        tx,
      );
    });
  }

  /** Stage 2E «Сборка»: the Physical ID typed or scanned for this order (warehouse, admin). */
  pickUnit(staff: StaffContext, id: string, dto: PickUnitDto) {
    return this.unitStep(staff, id, (tx, order) => this.units.pick(tx, order, dto.physical_id, dto.fefo_reason ?? null, staff.staff.id));
  }

  /** Stage 2E «Зарезервировать банки» for an order in «Нужно внимание склада». */
  reserveUnits(staff: StaffContext, id: string) {
    return this.unitStep(staff, id, async (tx, order) => {
      const reserved = await this.units.reserveMissing(tx, order, staff.staff.id);
      await this.audit.log({ staffId: staff.staff.id, action: 'order.units_reserved', entityType: 'order', entityId: id, after: { reserved } }, tx);
      return `Зарезервированы: ${reserved.join(', ')}`;
    });
  }

  /**
   * Stage 2E, after the handover (there was no such action before): the order comes back. Handed / in transit →
   * Cancelled, delivered → Return. Units of unit-tracked lines wait for a check («Возврат на проверке») and are
   * decided one by one on the warehouse screen; a refund task is created (refunds are manual). Lines by quantity:
   * the stock is not changed here (as before, their return to stock is «Склад → Возврат»).
   */
  returnOrder(staff: StaffContext, id: string, reason: string) {
    return this.unitStep(staff, id, async (tx, order) => {
      const to: OrderStatus | null = order.status === 'delivered' ? 'return' : order.status === 'handed_to_delivery' || order.status === 'in_transit' ? 'cancelled' : null;
      if (!to) throw new ConflictException({ code: 'INVALID_STATUS_TRANSITION', message: 'Возврат оформляется только после передачи в доставку' });
      const returned = await this.units.returnAfterHandover(tx, order, staff.staff.id, reason);
      const full = await tx.orders.update({ where: { id }, data: { status: to, ...(to === 'cancelled' && { cancelled_at: new Date() }) } });
      await tx.manager_tasks.create({ data: { type: 'refund', order_id: id, note: `Вернуть клиенту ${Number(full.total_uzs)} сум: заказ ${order.order_number} возвращён после отправки. Причина: ${reason}` } });
      await this.lifecycle.addHistory(tx, id, order.status, to, { type: 'staff', id: staff.staff.id }, reason);
      await this.audit.log({ staffId: staff.staff.id, action: 'order.returned', entityType: 'order', entityId: id, before: { status: order.status }, after: { status: to, reason, returned } }, tx);
      return returned.length ? `Возврат оформлен: банки ${returned.join(', ')} ждут проверки на складе` : 'Возврат оформлен';
    });
  }

  private async unitStep(staff: StaffContext, id: string, fn: (tx: Prisma.TransactionClient, order: Awaited<ReturnType<OrderLifecycleService['lockOrder']>>) => Promise<string>) {
    let message = '';
    await this.prisma.$transaction(async (tx) => {
      message = await fn(tx, await this.lifecycle.lockOrder(tx, id));
    }, TX);
    return { ...(await this.get(id, staff)), message };
  }

  /**
   * Edit recipient/address before handover. Changing the city recalculates delivery, which is only
   * possible while unpaid (a paid amount cannot silently change). Every edit goes to order_edit_log + audit.
   */
  edit(staff: StaffContext, id: string, dto: EditOrderDto) {
    return this.inOrderTx(id, async (tx, locked) => {
      if (!EDITABLE_STATUSES.includes(locked.status)) {
        throw new ConflictException({ code: 'ORDER_LOCKED', message: 'The order was handed to delivery and can no longer be edited' });
      }
      const order = await tx.orders.findUniqueOrThrow({ where: { id } });
      const { reason, ...fields } = dto;
      const data: Prisma.ordersUncheckedUpdateInput = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const set = (key: 'recipient_name' | 'recipient_phone' | 'address_text' | 'customer_comment', value: string | undefined) => {
        if (value === undefined || value === order[key]) return;
        before[key] = order[key];
        after[key] = value;
        data[key] = value;
      };
      set('recipient_name', fields.recipient_name);
      set('recipient_phone', fields.recipient_phone);
      set('address_text', fields.address_text);
      set('customer_comment', fields.customer_comment);

      const regionId = fields.region_id ?? order.region_id;
      const cityId = fields.city_id ?? order.city_id;
      if (regionId !== order.region_id || cityId !== order.city_id) {
        if (order.payment_status !== 'payment_pending') {
          throw new ConflictException({ code: 'PAID_ORDER_CITY_LOCKED', message: 'The delivery city of a paid order cannot be changed' });
        }
        const goods = Number(order.goods_total_uzs - order.discount_total_uzs);
        const quote = await this.delivery.quote(regionId, cityId, goods, tx);
        const total = Number(order.goods_paid_uzs) + quote.cost_uzs;
        Object.assign(before, { region_id: order.region_id, city_id: order.city_id, delivery_cost_uzs: order.delivery_cost_uzs, total_uzs: order.total_uzs });
        Object.assign(after, { region_id: regionId, city_id: cityId, delivery_cost_uzs: quote.cost_uzs, total_uzs: total });
        Object.assign(data, { region_id: regionId, city_id: cityId, delivery_cost_uzs: BigInt(quote.cost_uzs), total_uzs: BigInt(total) });
        await tx.payments.updateMany({ where: { order_id: id, status: 'payment_pending' }, data: { amount_uzs: BigInt(total) } });
      }

      if (!Object.keys(after).length) return; // nothing changed
      await tx.orders.update({ where: { id }, data });
      await tx.order_edit_log.create({
        data: { order_id: id, staff_user_id: staff.staff.id, before_json: auditJson(before), after_json: auditJson(after), reason },
      });
      await this.audit.log({ staffId: staff.staff.id, action: 'order.edited', entityType: 'order', entityId: id, before, after: { ...after, reason } }, tx);
    });
  }

  private async inOrderTx(
    id: string,
    fn: (tx: Prisma.TransactionClient, order: Awaited<ReturnType<OrderLifecycleService['lockOrder']>>) => Promise<void>,
  ) {
    await this.prisma.$transaction(async (tx) => fn(tx, await this.lifecycle.lockOrder(tx, id)), TX);
  }
}

@ApiTags('staff: orders')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/orders')
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

  @Get()
  @RequirePermission('orders.view')
  list(@Query() q: StaffOrdersQuery) {
    return this.orders.list(q);
  }

  @Get(':id')
  @RequirePermission('orders.view')
  get(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.orders.get(id, me);
  }

  @Post(':id/confirm-payment')
  @HttpCode(200)
  @RequirePermission('orders.payment')
  async confirmPayment(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ConfirmPaymentDto) {
    await this.orders.confirmPayment(me, id, dto.comment);
    return this.orders.get(id, me);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('orders.fulfil', 'orders.deliver')
  async status(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ChangeStatusDto) {
    await this.orders.changeStatus(me, id, dto.status, dto.comment);
    return this.orders.get(id, me);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('orders.cancel')
  async cancel(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: StaffCancelDto) {
    await this.orders.cancel(me, id, dto.reason);
    return this.orders.get(id, me);
  }

  @Post(':id/units/pick')
  @HttpCode(200)
  @RequirePermission('orders.units')
  pickUnit(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PickUnitDto) {
    return this.orders.pickUnit(me, id, dto);
  }

  @Post(':id/units/reserve')
  @HttpCode(200)
  @RequirePermission('orders.units')
  reserveUnits(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.orders.reserveUnits(me, id);
  }

  @Post(':id/return')
  @HttpCode(200)
  @RequirePermission('orders.units')
  returnOrder(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: StaffCancelDto) {
    return this.orders.returnOrder(me, id, dto.reason);
  }

  @Patch(':id')
  @RequirePermission('orders.edit')
  async edit(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: EditOrderDto) {
    await this.orders.edit(me, id, dto);
    return this.orders.get(id, me);
  }
}

