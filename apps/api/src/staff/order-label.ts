import { Body, ConflictException, Controller, ForbiddenException, HttpCode, Injectable, InternalServerErrorException, NotFoundException, Param, ParseUUIDPipe, Patch, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { tashkentDateString } from '../common/tashkent';
import { PrismaService } from '../prisma/prisma.service';
import { printTicketKey, PrintTicketError, signPrintTicket, TICKET_TTL_SECONDS, verifyPrintTicket } from '../receiving/print-ticket';
import { AuditService } from './audit.service';
import { can, type Permission } from './permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

/**
 * Shipping label of a Mini App order, 75×120 mm (S2E-13). Not for Yandex orders: Yandex has its own labels.
 *
 * The label page opens in a normal browser with a print ticket (like the Physical ID labels): the ticket names ONE
 * order, lives 15 minutes and dies with the employee's session. The name, phone and address of the customer go only
 * to that page and to the paper: the audit log gets the fact «наклейка напечатана» with the order number, nothing else,
 * and nothing of them is written to the server log.
 */
export const LABEL_PERMISSION: Permission = 'orders.view'; // manager, warehouse, admin: whoever sees the order may print it
/** A label makes sense for a paid order that is not closed. */
const PRINTABLE = ['paid', 'picking', 'handed_to_delivery', 'in_transit', 'delivered'];
export const WAYBILL_MAX = 64;

const textOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export class WaybillDto {
  @ApiPropertyOptional({ description: 'Номер накладной службы доставки (BTS, Яндекс Go…); пусто — убрать', example: 'BTS-12345678' })
  @IsOptional()
  @Transform(textOrNull)
  @IsString()
  @MaxLength(WAYBILL_MAX)
  // what a waybill number looks like: letters, digits and a few separators — never a free text
  @Matches(/^[0-9A-Za-zА-Яа-яЁё#№][0-9A-Za-zА-Яа-яЁё ._/#№-]*$/, { message: 'Номер накладной: буквы, цифры и знаки . _ / # № -' })
  delivery_waybill?: string | null;
}

export class OrderLabelTicketDto {
  @ApiProperty({ description: 'Билет печати из POST /staff/orders/:id/label/ticket' }) @IsString() @IsNotEmpty() @MaxLength(4000) ticket!: string;
}

export interface OrderLabel {
  order_number: string;
  order_date: string; // YYYY-MM-DD, Tashkent
  prepaid: boolean;
  recipient: { name: string; phone: string };
  address: { region: string; city: string; text: string };
  items: { sku: string; name: string; qty: number }[];
  waybill: string | null;
}

@Injectable()
export class OrderLabelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private ticketKey() {
    const secret = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!secret) throw new InternalServerErrorException('TELEGRAM_BOT_TOKEN is not configured');
    return printTicketKey(secret);
  }

  private async printable(id: string) {
    const order = await this.prisma.orders.findUnique({ where: { id }, select: { id: true, status: true, payment_status: true } });
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    if (order.payment_status !== 'payment_success' || !PRINTABLE.includes(order.status)) {
      throw new ConflictException({ code: 'LABEL_NOT_AVAILABLE', message: 'Наклейка печатается только для оплаченного и не отменённого заказа' });
    }
    return order;
  }

  /** «Печать наклейки» in the order card: a ticket for the print page — this order only. */
  async issueTicket(me: StaffContext, id: string) {
    await this.printable(id);
    const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
    return { ticket: signPrintTicket(this.ticketKey(), { v: 1, ss: me.sessionId, exp, order_id: id }), expires_at: new Date(exp * 1000).toISOString() };
  }

  /** The print page: the label of the order the ticket names, on behalf of the employee who asked for it. */
  async printByTicket(ticket: string): Promise<{ label: OrderLabel }> {
    let p;
    try {
      p = verifyPrintTicket(this.ticketKey(), ticket);
    } catch (e) {
      if (!(e instanceof PrintTicketError)) throw e;
      throw new UnauthorizedException({ code: e.message === 'expired' ? 'PRINT_TICKET_EXPIRED' : 'PRINT_TICKET_INVALID', message: 'Ссылка на печать устарела или неверна' });
    }
    if (!p.order_id) throw new UnauthorizedException({ code: 'PRINT_TICKET_INVALID', message: 'Ссылка на печать устарела или неверна' });
    // Logout, block or an expired staff session end the ticket at once.
    const session = await this.prisma.staff_sessions.findUnique({ where: { id: p.ss }, include: { staff_user: true } });
    if (!session || session.revoked_at || session.expires_at <= new Date() || session.staff_user.status !== 'active') {
      throw new UnauthorizedException({ code: 'PRINT_TICKET_INVALID', message: 'Сессия сотрудника закончилась' });
    }
    if (!can(session.staff_user.role, LABEL_PERMISSION)) {
      throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE', message: `Role ${session.staff_user.role} cannot do this` });
    }
    await this.printable(p.order_id);
    const o = await this.prisma.orders.findUniqueOrThrow({
      where: { id: p.order_id },
      include: { region: { select: { name_ru: true } }, city: { select: { name_ru: true } }, items: { orderBy: { name_ru_snapshot: 'asc' } } },
    });
    // Only the fact and the order number: no name, phone or address ever goes to the audit log.
    await this.audit.log({ staffId: session.staff_user.id, action: 'order.label_printed', entityType: 'order', entityId: o.id, after: { order_number: o.order_number } });
    return {
      label: {
        order_number: o.order_number,
        order_date: tashkentDateString(o.created_at),
        prepaid: true,
        recipient: { name: o.recipient_name, phone: o.recipient_phone },
        address: { region: o.region.name_ru, city: o.city.name_ru, text: o.address_text },
        items: o.items.map((i) => ({ sku: i.sku_snapshot, name: i.name_ru_snapshot, qty: i.qty })),
        waybill: o.delivery_waybill,
      },
    };
  }

  /** «Номер накладной службы доставки»: optional, warehouse and admin, any time while the order is not cancelled. */
  async setWaybill(me: StaffContext, id: string, value: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.orders.findUnique({ where: { id }, select: { id: true, status: true, delivery_waybill: true } });
      if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
      if (order.status === 'cancelled') throw new ConflictException({ code: 'ORDER_CANCELLED', message: 'Заказ отменён' });
      if (order.delivery_waybill === value) return { id, delivery_waybill: value };
      await tx.orders.update({ where: { id }, data: { delivery_waybill: value } });
      await this.audit.log({ staffId: me.staff.id, action: 'order.waybill_changed', entityType: 'order', entityId: id, before: { delivery_waybill: order.delivery_waybill }, after: { delivery_waybill: value } }, tx);
      return { id, delivery_waybill: value };
    });
  }
}

@ApiTags('staff: orders')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/orders')
export class OrderLabelController {
  constructor(private readonly labels: OrderLabelService) {}

  @Post(':id/label/ticket')
  @HttpCode(200)
  @RequirePermission(LABEL_PERMISSION)
  ticket(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.labels.issueTicket(me, id);
  }

  @Patch(':id/waybill')
  @RequirePermission('orders.waybill')
  waybill(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: WaybillDto) {
    return this.labels.setWaybill(me, id, dto.delivery_waybill ?? null);
  }
}

/** The label page opened in a normal browser: no staff token, only the print ticket. It does exactly one thing. */
@ApiTags('staff: orders')
@Controller('print/order-label')
export class PrintOrderLabelController {
  constructor(private readonly labels: OrderLabelService) {}

  @Post()
  @HttpCode(200)
  print(@Body() dto: OrderLabelTicketDto) {
    return this.labels.printByTicket(dto.ticket);
  }
}
