import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
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
import { ApiBearerAuth, ApiHeader, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { MarketplaceOrderStatus, PhysicalUnitStatus, Prisma, StaffRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PageQuery } from '../catalog/catalog.dto';
import { requireIdempotencyKey, runIdempotent } from '../common/idempotency';
import { StockService } from '../inventory/stock.service';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhysicalId } from '../receiving/physical-id';
import { AuditService } from '../staff/audit.service';
import { can } from '../staff/permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from '../staff/staff-auth';
import { deductStock, moveUnit, releaseStock, reserveStock, UNIT_STATUS_RU, type StockMove } from './unit-lifecycle';

type Tx = Prisma.TransactionClient;
const PAGE_SIZE = 50;
export const DEFAULT_COMMISSION_PERCENT = 18.5;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const textOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

// ---------------------------------------------------------------- DTOs

export class YandexLineInput {
  @ApiProperty() @IsUUID() product_id!: string;
  @ApiProperty({ minimum: 1, maximum: 50 }) @IsInt() @Min(1) @Max(50) qty!: number;
  @ApiProperty({ description: 'Цена продажи за единицу, сум' }) @IsInt() @Min(0) @Max(1_000_000_000) unit_price_uzs!: number;
}

export class CreateYandexOrderDto {
  @ApiProperty({ example: '123456789' }) @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(64) external_number!: string;
  @ApiProperty({ example: '2026-10-10' }) @IsDateString({ strict: true }) order_date!: string;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(200) customer_name?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(1000) note?: string | null;
  @ApiPropertyOptional({ description: 'Только администратор; по умолчанию 18.5' }) @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99.99) commission_percent?: number;
  @ApiProperty({ type: [YandexLineInput] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => YandexLineInput) lines!: YandexLineInput[];
}

export class LinePriceInput {
  @ApiProperty() @IsUUID() line_id!: string;
  @ApiProperty() @IsInt() @Min(0) @Max(1_000_000_000) unit_price_uzs!: number;
}

/** Admin: commission and prices; note and customer for everybody with access. */
export class UpdateYandexOrderDto {
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(200) customer_name?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(1000) note?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99.99) commission_percent?: number;
  @ApiPropertyOptional({ type: [LinePriceInput] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => LinePriceInput) prices?: LinePriceInput[];
}

export class PickDto {
  @ApiProperty({ example: 'V-000184' }) @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(40) physical_id!: string;
  @ApiPropertyOptional({ description: 'Причина, если выбрана не самая старая банка (мягкий FEFO)' })
  @IsOptional() @Transform(textOrNull) @IsString() @MinLength(3) @MaxLength(300) fefo_reason?: string | null;
}

export class ReasonDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

export class YandexOrdersQuery extends PageQuery {
  @ApiPropertyOptional({ enum: MarketplaceOrderStatus }) @IsOptional() @IsEnum(MarketplaceOrderStatus) status?: MarketplaceOrderStatus;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) to?: string;
  @ApiPropertyOptional({ description: 'Номер заказа Яндекса' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(64) q?: string;
}

// ---------------------------------------------------------------- money (admin only)

/** Profit of a Yandex order: price − commission (price × %) − cost of the very units. No Yandex logistics (S2C-6). */
export function orderMoney(lines: { qty: number; unit_price_uzs: bigint }[], unitCosts: bigint[], commissionPercent: number) {
  const revenue = lines.reduce((s, l) => s + Number(l.unit_price_uzs) * l.qty, 0);
  const commission = Math.round((revenue * commissionPercent) / 100);
  const cost = unitCosts.reduce((s, c) => s + Number(c), 0);
  return { revenue_uzs: revenue, commission_uzs: commission, cost_uzs: cost, profit_uzs: revenue - commission - cost };
}

export const ORDER_STATUS_RU: Record<MarketplaceOrderStatus, string> = {
  NEW: 'Новый',
  ASSEMBLED: 'Собран',
  HANDED_TO_DELIVERY: 'Передан в доставку',
  DELIVERED: 'Доставлен',
  CANCELLED: 'Отменён',
  RETURNED: 'Возврат',
};

const orderInclude = {
  lines: { orderBy: { position: 'asc' }, include: { product: { select: { id: true, sku: true, name_ru: true } } } },
  units: {
    orderBy: { assigned_at: 'asc' },
    include: { unit: { select: { id: true, physical_id: true, expiry_date: true, status: true, actual_cost_uzs: true, product_id: true } } },
  },
  staff: { select: { name: true } },
} satisfies Prisma.marketplace_ordersInclude;
type OrderRow = Prisma.marketplace_ordersGetPayload<{ include: typeof orderInclude }>;

const day = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------- service

/**
 * Stage 2C «Заказы Яндекса». Units are reserved by FEFO the moment the order is created; at assembly the
 * warehouse confirms each Physical ID (another unit of the same product can replace a reserved one; not the
 * earliest expiry -> reason required). Handed to delivery takes the units off the shelf; Delivered sells them.
 * Cancel before the handover frees the units; after it the order becomes a return and the units wait for a check.
 */
@Injectable()
export class YandexOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly audit: AuditService,
  ) {}

  async list(q: YandexOrdersQuery) {
    const where: Prisma.marketplace_ordersWhereInput = {
      marketplace: 'yandex',
      ...(q.status && { status: q.status }),
      ...(q.q && { external_number: { contains: q.q, mode: 'insensitive' } }),
      ...((q.from || q.to) && { order_date: { ...(q.from && { gte: new Date(`${q.from}T00:00:00Z`) }), ...(q.to && { lte: new Date(`${q.to}T00:00:00Z`) }) } }),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.marketplace_orders.count({ where }),
      this.prisma.marketplace_orders.findMany({
        where,
        orderBy: [{ order_date: 'desc' }, { created_at: 'desc' }],
        skip: (q.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { lines: { include: { product: { select: { sku: true } } } }, units: { where: { released_at: null }, select: { picked_at: true } } },
      }),
    ]);
    return {
      items: rows.map((o) => ({
        id: o.id,
        external_number: o.external_number,
        order_date: day(o.order_date),
        customer_name: o.customer_name,
        status: o.status,
        qty: o.lines.reduce((s, l) => s + l.qty, 0),
        picked: o.units.filter((u) => u.picked_at).length,
        skus: [...new Set(o.lines.map((l) => l.product.sku))],
        total_uzs: o.lines.reduce((s, l) => s + Number(l.unit_price_uzs) * l.qty, 0),
        created_at: o.created_at,
      })),
      page: q.page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
    };
  }

  async get(id: string, money: boolean) {
    const o = await this.prisma.marketplace_orders.findUnique({ where: { id }, include: orderInclude });
    if (!o) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    const history = await this.prisma.audit_logs.findMany({
      where: { entity_type: 'marketplace_order', entity_id: id },
      orderBy: { created_at: 'asc' },
      include: { staff: { select: { name: true } } },
    });
    return this.view(o, money, history);
  }

  private view(o: OrderRow, money: boolean, history: { action: string; created_at: Date; after_json: Prisma.JsonValue; staff: { name: string } | null }[] = []) {
    const active = o.units.filter((a) => !a.released_at);
    const lines = o.lines.map((l) => {
      const units = active.filter((a) => a.line_id === l.id);
      return {
        id: l.id,
        product: l.product,
        qty: l.qty,
        unit_price_uzs: Number(l.unit_price_uzs),
        units: units.map((a) => ({
          assignment_id: a.id,
          unit_id: a.unit.id,
          physical_id: a.unit.physical_id,
          expiry_date: day(a.unit.expiry_date),
          status: a.unit.status,
          picked: !!a.picked_at,
          fefo_override: a.fefo_override,
          ...(money && { actual_cost_uzs: Number(a.unit.actual_cost_uzs) }),
        })),
        picked: units.filter((a) => a.picked_at).length,
      };
    });
    const released = o.units.filter((a) => a.released_at);
    const pct = Number(o.commission_percent);
    return {
      id: o.id,
      marketplace: o.marketplace,
      external_number: o.external_number,
      order_date: day(o.order_date),
      customer_name: o.customer_name,
      status: o.status,
      note: o.note,
      cancel_reason: o.cancel_reason,
      created_by_name: o.staff?.name ?? null,
      created_at: o.created_at,
      assembled_at: o.assembled_at,
      handed_at: o.handed_at,
      delivered_at: o.delivered_at,
      closed_at: o.closed_at,
      total_uzs: lines.reduce((s, l) => s + l.unit_price_uzs * l.qty, 0),
      lines,
      released: released.map((a) => ({
        physical_id: a.unit.physical_id,
        status: a.unit.status,
        released_at: a.released_at,
        reason: a.release_reason,
        return_decision: a.return_decision,
      })),
      history: history.map((h) => ({ action: h.action, at: h.created_at, staff_name: h.staff?.name ?? null, details: h.after_json })),
      ...(money && {
        commission_percent: pct,
        money: o.status === 'CANCELLED' || o.status === 'RETURNED' ? null : orderMoney(o.lines, active.map((a) => a.unit.actual_cost_uzs), pct),
      }),
    };
  }

  /** Creates the order and reserves units by FEFO, all or nothing, exactly once per Idempotency-Key. */
  async create(me: StaffContext, key: string, dto: CreateYandexOrderDto) {
    if (dto.commission_percent !== undefined && !can(me.staff.role, 'yandex.orders.money')) {
      throw new ForbiddenException({ code: 'COMMISSION_FORBIDDEN', message: 'Комиссию меняет только администратор' });
    }
    const res = await runIdempotent(
      this.prisma,
      {
        scope: 'yandex.create',
        staffId: me.staff.id,
        key,
        request: dto,
        onUniqueConflict: () => {
          throw new ConflictException({ code: 'ORDER_EXISTS', message: `Заказ Яндекса №${dto.external_number} уже есть` });
        },
      },
      async (tx) => {
        const products = await tx.products.findMany({ where: { id: { in: dto.lines.map((l) => l.product_id) } }, select: { id: true, sku: true, unit_tracking: true } });
        for (const l of dto.lines) {
          const p = products.find((x) => x.id === l.product_id);
          if (!p) throw new BadRequestException({ code: 'UNKNOWN_PRODUCT', message: 'Товар не найден' });
          if (!p.unit_tracking) throw new ConflictException({ code: 'NOT_UNIT_TRACKED', message: `${p.sku}: товар не учитывается по банкам (Physical ID)` });
        }
        const order = await tx.marketplace_orders.create({
          data: {
            marketplace: 'yandex',
            external_number: dto.external_number,
            order_date: new Date(`${dto.order_date}T00:00:00Z`),
            customer_name: dto.customer_name ?? null,
            note: dto.note ?? null,
            commission_percent: dto.commission_percent ?? DEFAULT_COMMISSION_PERCENT,
            created_by: me.staff.id,
            lines: { create: dto.lines.map((l, i) => ({ product_id: l.product_id, position: i + 1, qty: l.qty, unit_price_uzs: BigInt(l.unit_price_uzs) })) },
          },
          include: { lines: true },
        });
        const warehouseId = await this.stock.mainWarehouseId(tx);
        // Fixed lock order (by product id): two orders with the same products cannot deadlock.
        const byProduct = new Map<string, { lineId: string; qty: number }[]>();
        for (const l of order.lines) byProduct.set(l.product_id, [...(byProduct.get(l.product_id) ?? []), { lineId: l.id, qty: l.qty }]);
        const reserved: string[] = [];
        for (const productId of [...byProduct.keys()].sort()) {
          const lines = byProduct.get(productId)!;
          const n = lines.reduce((s, l) => s + l.qty, 0);
          const sku = products.find((p) => p.id === productId)!.sku;
          const move: StockMove = { warehouseId, productId, referenceType: 'marketplace_order', referenceId: order.id, reason: `Резерв банок под заказ Яндекса ${order.external_number}`, staffId: me.staff.id };
          try {
            await reserveStock(tx, move, n);
          } catch (e) {
            if (e instanceof ConflictException) {
              const r = e.getResponse() as { available?: number };
              throw new ConflictException({ code: 'INSUFFICIENT_STOCK', message: `${sku}: нужно ${n} шт., свободно ${r.available ?? 0} (остальное в резерве заказов)` });
            }
            throw e;
          }
          // FEFO: the earliest expiry first, then the lowest number. SKIP LOCKED: a parallel order takes other units.
          const units = await tx.$queryRaw<{ id: string; physical_id: string }[]>`
            SELECT id, physical_id FROM physical_units
            WHERE product_id = ${productId}::uuid AND status = 'IN_STOCK'
              AND NOT EXISTS (SELECT 1 FROM marketplace_order_units a WHERE a.physical_unit_id = physical_units.id AND a.released_at IS NULL)
            ORDER BY expiry_date, seq
            LIMIT ${n}
            FOR UPDATE SKIP LOCKED`;
          if (units.length < n) {
            throw new ConflictException({ code: 'NOT_ENOUGH_UNITS', message: `${sku}: нужно ${n} банок, на складе свободно ${units.length}` });
          }
          let k = 0;
          for (const line of lines) {
            for (let i = 0; i < line.qty; i++, k++) {
              await this.assign(tx, order.id, line.lineId, units[k].id, me.staff.id, null, false);
              reserved.push(units[k].physical_id);
            }
          }
        }
        await this.audit.log(
          { staffId: me.staff.id, action: 'yandex_order.created', entityType: 'marketplace_order', entityId: order.id, after: { external_number: order.external_number, lines: dto.lines, reserved } },
          tx,
        );
        return { id: order.id };
      },
    );
    return { ...(await this.get(res.id, can(me.staff.role, 'yandex.orders.money'))), replayed: res.replayed };
  }

  /** Admin: commission and prices (profit); everybody with access: note and customer name. */
  async update(me: StaffContext, id: string, dto: UpdateYandexOrderDto) {
    const money = can(me.staff.role, 'yandex.orders.money');
    if (!money && (dto.commission_percent !== undefined || dto.prices?.length)) {
      throw new ForbiddenException({ code: 'COMMISSION_FORBIDDEN', message: 'Цену и комиссию меняет только администратор' });
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await this.lock(tx, id);
      const lines = await tx.marketplace_order_lines.findMany({ where: { order_id: id } });
      for (const p of dto.prices ?? []) {
        if (!lines.some((l) => l.id === p.line_id)) throw new BadRequestException({ code: 'LINE_NOT_FOUND', message: 'Этой позиции нет в заказе' });
        await tx.marketplace_order_lines.update({ where: { id: p.line_id }, data: { unit_price_uzs: BigInt(p.unit_price_uzs) } });
      }
      await tx.marketplace_orders.update({
        where: { id },
        data: {
          ...(dto.customer_name !== undefined && { customer_name: dto.customer_name }),
          ...(dto.note !== undefined && { note: dto.note }),
          ...(dto.commission_percent !== undefined && { commission_percent: dto.commission_percent }),
        },
      });
      await this.audit.log(
        {
          staffId: me.staff.id,
          action: 'yandex_order.updated',
          entityType: 'marketplace_order',
          entityId: id,
          before: { customer_name: before.customer_name, note: before.note, commission_percent: Number(before.commission_percent), prices: lines.map((l) => ({ line_id: l.id, unit_price_uzs: Number(l.unit_price_uzs) })) },
          after: dto,
        },
        tx,
      );
    });
    return this.get(id, money);
  }

  /**
   * Assembly: the Physical ID typed (or scanned) for this order. A reserved unit of the order -> confirmed. Another
   * free unit of a product of the order replaces one not yet confirmed reserved unit of that product (that one goes
   * back to stock). Not the earliest expiry -> 409 FEFO_REASON_REQUIRED until a reason is given.
   */
  async pick(me: StaffContext, key: string, id: string, dto: PickDto) {
    const physicalId = normalizePhysicalId(dto.physical_id);
    if (!physicalId) throw new BadRequestException({ code: 'BAD_PHYSICAL_ID', message: 'Это не Physical ID: введите, например, V-000184 или 184' });
    return this.step(me, key, id, 'pick', { physical_id: physicalId, fefo_reason: dto.fefo_reason ?? null }, async (tx, order) => {
      if (order.status !== 'NEW') throw this.badStatus(order.status, 'собирать');
      const [unit] = await tx.$queryRaw<{ id: string; physical_id: string; product_id: string; status: PhysicalUnitStatus; expiry_date: Date }[]>`
        SELECT id, physical_id, product_id, status, expiry_date FROM physical_units WHERE physical_id = ${physicalId} FOR UPDATE`;
      if (!unit) throw new NotFoundException({ code: 'UNIT_NOT_FOUND', message: `Банка ${physicalId} не найдена` });
      const active = await tx.marketplace_order_units.findMany({ where: { order_id: id, released_at: null }, include: { unit: { select: { physical_id: true, expiry_date: true, product_id: true } } } });

      const own = active.find((a) => a.physical_unit_id === unit.id);
      if (own) {
        if (own.picked_at) return { message: `${physicalId} уже отмечена в этом заказе` };
        await tx.marketplace_order_units.update({ where: { id: own.id }, data: { picked_at: new Date() } });
        await this.unitNote(tx, unit.id, 'PICKED', id, me.staff.id, null);
        await this.audit.log({ staffId: me.staff.id, action: 'yandex_order.picked', entityType: 'marketplace_order', entityId: id, after: { physical_id: physicalId } }, tx);
        return { message: `${physicalId} собрана` };
      }

      const taken = await tx.marketplace_order_units.findFirst({ where: { physical_unit_id: unit.id, released_at: null }, include: { order: { select: { external_number: true } } } });
      if (taken) throw new ConflictException({ code: 'UNIT_TAKEN', message: `${physicalId} уже в заказе Яндекса №${taken.order.external_number}` });
      const lines = await tx.marketplace_order_lines.findMany({ where: { order_id: id }, include: { product: { select: { sku: true } } } });
      const sameProduct = lines.filter((l) => l.product_id === unit.product_id);
      if (!sameProduct.length) {
        const p = await tx.products.findUnique({ where: { id: unit.product_id }, select: { sku: true } });
        throw new ConflictException({ code: 'WRONG_PRODUCT', message: `${physicalId} — это ${p?.sku}, такого товара в заказе нет (${[...new Set(lines.map((l) => l.product.sku))].join(', ')})` });
      }
      if (unit.status !== 'IN_STOCK') {
        throw new ConflictException({ code: 'UNIT_NOT_AVAILABLE', message: `${physicalId}: статус «${statusRu(unit.status)}», в заказ можно взять только банку «На складе»` });
      }
      // The reserved, not yet confirmed unit of this product that the typed one replaces: the latest expiry first,
      // so the remaining reservations stay the oldest.
      const replaceable = active
        .filter((a) => !a.picked_at && a.unit.product_id === unit.product_id)
        .sort((a, b) => b.unit.expiry_date.getTime() - a.unit.expiry_date.getTime());
      if (!replaceable.length) throw new ConflictException({ code: 'LINE_COMPLETE', message: `Все банки ${sameProduct[0].product.sku} в этом заказе уже собраны` });

      // Soft FEFO: is there a unit with an earlier expiry (free on the shelf or reserved here and not confirmed)?
      const [free] = await tx.$queryRaw<{ physical_id: string; expiry_date: Date }[]>`
        SELECT physical_id, expiry_date FROM physical_units
        WHERE product_id = ${unit.product_id}::uuid AND status = 'IN_STOCK' AND id <> ${unit.id}::uuid
        ORDER BY expiry_date, seq LIMIT 1`;
      const candidates = [...replaceable.map((a) => ({ physical_id: a.unit.physical_id, expiry_date: a.unit.expiry_date })), ...(free ? [free] : [])];
      const oldest = candidates.sort((a, b) => a.expiry_date.getTime() - b.expiry_date.getTime())[0];
      const notFefo = oldest && oldest.expiry_date.getTime() < unit.expiry_date.getTime();
      if (notFefo && !dto.fefo_reason) {
        throw new ConflictException({
          code: 'FEFO_REASON_REQUIRED',
          message: `Есть банка со сроком раньше: рекомендуем ${oldest.physical_id}, срок ${ruDate(oldest.expiry_date)}. Чтобы взять ${physicalId} (срок ${ruDate(unit.expiry_date)}), укажите причину.`,
          recommended: { physical_id: oldest.physical_id, expiry_date: day(oldest.expiry_date) },
        });
      }

      const out = replaceable[0];
      const warehouseId = await this.stock.mainWarehouseId(tx);
      const move: StockMove = { warehouseId, productId: unit.product_id, referenceType: 'marketplace_order', referenceId: id, staffId: me.staff.id };
      // Swap: the reserved unit goes back to stock and the typed one is reserved instead — the reserved quantity stays.
      await tx.marketplace_order_units.update({ where: { id: out.id }, data: { released_at: new Date(), release_reason: `Заменена при сборке на ${physicalId}` } });
      await moveUnit(tx, out.physical_unit_id, 'ASSIGNED', 'IN_STOCK', { type: 'RELEASED', note: `Заменена при сборке на ${physicalId}`, referenceType: 'marketplace_order', referenceId: id, staffId: me.staff.id });
      await releaseStock(tx, { ...move, reason: `Замена ${out.unit.physical_id} → ${physicalId}` }, 1);
      await reserveStock(tx, { ...move, reason: `Замена ${out.unit.physical_id} → ${physicalId}` }, 1);
      await this.assign(tx, id, out.line_id, unit.id, me.staff.id, notFefo ? dto.fefo_reason! : null, true);
      await this.audit.log(
        { staffId: me.staff.id, action: 'yandex_order.unit_replaced', entityType: 'marketplace_order', entityId: id, after: { from: out.unit.physical_id, to: physicalId, fefo_reason: notFefo ? dto.fefo_reason : null } },
        tx,
      );
      return { message: `${physicalId} собрана вместо ${out.unit.physical_id}${notFefo ? ' (не самый ранний срок, причина записана)' : ''}` };
    });
  }

  /** NEW -> ASSEMBLED: every reserved unit confirmed by its Physical ID. */
  assemble(me: StaffContext, key: string, id: string) {
    return this.step(me, key, id, 'assemble', {}, async (tx, order) => {
      if (order.status !== 'NEW') throw this.badStatus(order.status, 'отметить собранным');
      const lines = await tx.marketplace_order_lines.findMany({ where: { order_id: id }, include: { units: { where: { released_at: null } }, product: { select: { sku: true } } } });
      const missing = lines.filter((l) => l.units.length !== l.qty || l.units.some((u) => !u.picked_at));
      if (missing.length) {
        throw new ConflictException({
          code: 'NOT_ALL_PICKED',
          message: `Не все банки отмечены: ${missing.map((l) => `${l.product.sku} ${l.units.filter((u) => u.picked_at).length} из ${l.qty}`).join(', ')}`,
        });
      }
      await this.setStatus(tx, me, order, 'ASSEMBLED', { assembled_at: new Date() });
      return { message: 'Заказ собран' };
    });
  }

  /** ASSEMBLED -> HANDED_TO_DELIVERY: the units leave the shelf (stock goes down now). */
  handOver(me: StaffContext, key: string, id: string) {
    return this.step(me, key, id, 'hand_over', {}, async (tx, order) => {
      if (order.status !== 'ASSEMBLED') throw this.badStatus(order.status, 'передать в доставку');
      const units = await this.activeUnits(tx, id);
      const warehouseId = await this.stock.mainWarehouseId(tx);
      for (const a of units) {
        await moveUnit(tx, a.physical_unit_id, 'ASSIGNED', 'YANDEX_DELIVERY', { type: 'HANDED_TO_DELIVERY', referenceType: 'marketplace_order', referenceId: id, staffId: me.staff.id });
      }
      for (const [productId, n] of countBy(units.map((a) => a.unit.product_id))) {
        await deductStock(tx, { warehouseId, productId, referenceType: 'marketplace_order', referenceId: id, reason: `Передан в доставку: Яндекс ${order.external_number}`, staffId: me.staff.id }, n);
      }
      await this.setStatus(tx, me, order, 'HANDED_TO_DELIVERY', { handed_at: new Date() });
      return { message: 'Передан в доставку' };
    });
  }

  /** HANDED_TO_DELIVERY -> DELIVERED: the units are sold. */
  deliver(me: StaffContext, key: string, id: string) {
    return this.step(me, key, id, 'deliver', {}, async (tx, order) => {
      if (order.status !== 'HANDED_TO_DELIVERY') throw this.badStatus(order.status, 'отметить доставленным');
      for (const a of await this.activeUnits(tx, id)) {
        await moveUnit(tx, a.physical_unit_id, 'YANDEX_DELIVERY', 'YANDEX_SOLD', { type: 'SOLD', referenceType: 'marketplace_order', referenceId: id, staffId: me.staff.id });
      }
      await this.setStatus(tx, me, order, 'DELIVERED', { delivered_at: new Date() });
      return { message: 'Доставлен' };
    });
  }

  /**
   * Before the handover (NEW / ASSEMBLED, also half picked): CANCELLED, every unit back on stock, the reservation
   * released. After it (HANDED_TO_DELIVERY / DELIVERED): RETURNED, the units wait for a check («Возврат на проверке»).
   */
  cancel(me: StaffContext, key: string, id: string, dto: ReasonDto) {
    return this.step(me, key, id, 'cancel', dto, async (tx, order) => {
      const units = await this.activeUnits(tx, id);
      if (order.status === 'NEW' || order.status === 'ASSEMBLED') {
        const warehouseId = await this.stock.mainWarehouseId(tx);
        for (const a of units) {
          await tx.marketplace_order_units.update({ where: { id: a.id }, data: { released_at: new Date(), release_reason: `Отмена заказа: ${dto.reason}` } });
          await moveUnit(tx, a.physical_unit_id, 'ASSIGNED', 'IN_STOCK', { type: 'RELEASED', note: `Отмена заказа: ${dto.reason}`, referenceType: 'marketplace_order', referenceId: id, staffId: me.staff.id });
        }
        for (const [productId, n] of countBy(units.map((a) => a.unit.product_id))) {
          await releaseStock(tx, { warehouseId, productId, referenceType: 'marketplace_order', referenceId: id, reason: `Отмена заказа Яндекса ${order.external_number}: ${dto.reason}`, staffId: me.staff.id }, n);
        }
        await this.setStatus(tx, me, order, 'CANCELLED', { cancel_reason: dto.reason, closed_at: new Date() }, { reason: dto.reason, released: units.map((a) => a.unit.physical_id) });
        return { message: 'Заказ отменён, банки вернулись на склад' };
      }
      if (order.status === 'HANDED_TO_DELIVERY' || order.status === 'DELIVERED') {
        for (const a of units) {
          await moveUnit(tx, a.physical_unit_id, a.unit.status, 'RETURNED', { type: 'RETURNED', note: dto.reason, referenceType: 'marketplace_order', referenceId: id, staffId: me.staff.id });
        }
        await this.setStatus(tx, me, order, 'RETURNED', { cancel_reason: dto.reason, closed_at: new Date() }, { reason: dto.reason, returned: units.map((a) => a.unit.physical_id) });
        return { message: 'Оформлен возврат: банки ждут проверки на складе' };
      }
      throw this.badStatus(order.status, 'отменить');
    });
  }

  // ---------------------------------------------------------------- helpers

  /** One order action: order row locked, exactly once per Idempotency-Key, answers with the fresh card. */
  private async step(me: StaffContext, key: string, id: string, action: string, request: object, fn: (tx: Tx, order: Awaited<ReturnType<YandexOrdersService['lock']>>) => Promise<{ message: string }>) {
    const res = await runIdempotent(this.prisma, { scope: `yandex.${action}:${id}`, staffId: me.staff.id, key, request }, async (tx) => fn(tx, await this.lock(tx, id)));
    return { ...(await this.get(id, can(me.staff.role, 'yandex.orders.money'))), message: res.message, replayed: res.replayed };
  }

  private async lock(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM marketplace_orders WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    return tx.marketplace_orders.findUniqueOrThrow({ where: { id } });
  }

  private activeUnits(tx: Tx, id: string) {
    return tx.marketplace_order_units.findMany({
      where: { order_id: id, released_at: null },
      orderBy: { assigned_at: 'asc' },
      include: { unit: { select: { physical_id: true, product_id: true, status: true } } },
    });
  }

  private async assign(tx: Tx, orderId: string, lineId: string, unitId: string, staffId: string, fefoReason: string | null, picked: boolean) {
    try {
      await tx.marketplace_order_units.create({
        data: { order_id: orderId, line_id: lineId, physical_unit_id: unitId, assigned_by: staffId, fefo_override: fefoReason, picked_at: picked ? new Date() : null },
      });
    } catch (e) {
      // the partial unique index «one active order per unit»
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: 'UNIT_TAKEN', message: 'Эта банка только что ушла в другой заказ — повторите' });
      }
      throw e;
    }
    await moveUnit(tx, unitId, 'IN_STOCK', 'ASSIGNED', {
      type: picked ? 'PICKED' : 'ASSIGNED',
      note: fefoReason ? `Не самый ранний срок: ${fefoReason}` : null,
      referenceType: 'marketplace_order',
      referenceId: orderId,
      staffId,
    });
  }

  private unitNote(tx: Tx, unitId: string, type: string, orderId: string, staffId: string, note: string | null) {
    return tx.physical_unit_events.create({ data: { physical_unit_id: unitId, type, reference_type: 'marketplace_order', reference_id: orderId, note, created_by: staffId } });
  }

  private async setStatus(tx: Tx, me: StaffContext, order: { id: string; status: MarketplaceOrderStatus }, to: MarketplaceOrderStatus, data: Prisma.marketplace_ordersUpdateInput, extra?: object) {
    await tx.marketplace_orders.update({ where: { id: order.id }, data: { ...data, status: to } });
    await this.audit.log(
      { staffId: me.staff.id, action: 'yandex_order.status', entityType: 'marketplace_order', entityId: order.id, before: { status: order.status }, after: { status: to, ...extra } },
      tx,
    );
  }

  private badStatus(status: MarketplaceOrderStatus, what: string) {
    return new ConflictException({ code: 'INVALID_STATUS_TRANSITION', message: `Заказ в статусе «${ORDER_STATUS_RU[status]}»: ${what} нельзя` });
  }
}

const countBy = (ids: string[]) => {
  const m = new Map<string, number>();
  for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
};
const ruDate = (d: Date) => `${day(d).slice(8, 10)}.${day(d).slice(5, 7)}.${day(d).slice(0, 4)}`;
const statusRu = (s: PhysicalUnitStatus) => UNIT_STATUS_RU[s];

// ---------------------------------------------------------------- controller

const moneyFor = (role: StaffRole) => can(role, 'yandex.orders.money');

@ApiTags('staff: yandex orders')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@RequirePermission('yandex.orders')
@Controller('staff/yandex-orders')
export class YandexOrdersController {
  constructor(private readonly orders: YandexOrdersService) {}

  @Get()
  list(@Query() q: YandexOrdersQuery) {
    return this.orders.list(q);
  }

  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  create(@CurrentStaff() me: StaffContext, @Headers('idempotency-key') key: string | undefined, @Body() dto: CreateYandexOrderDto) {
    return this.orders.create(me, requireIdempotencyKey(key), dto);
  }

  @Get(':id')
  get(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.orders.get(id, moneyFor(me.staff.role));
  }

  @Patch(':id')
  update(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateYandexOrderDto) {
    return this.orders.update(me, id, dto);
  }

  @Post(':id/pick')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  pick(@CurrentStaff() me: StaffContext, @Headers('idempotency-key') key: string | undefined, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PickDto) {
    return this.orders.pick(me, requireIdempotencyKey(key), id, dto);
  }

  @Post(':id/assemble')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  assemble(@CurrentStaff() me: StaffContext, @Headers('idempotency-key') key: string | undefined, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.orders.assemble(me, requireIdempotencyKey(key), id);
  }

  @Post(':id/hand-over')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  handOver(@CurrentStaff() me: StaffContext, @Headers('idempotency-key') key: string | undefined, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.orders.handOver(me, requireIdempotencyKey(key), id);
  }

  @Post(':id/deliver')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  deliver(@CurrentStaff() me: StaffContext, @Headers('idempotency-key') key: string | undefined, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.orders.deliver(me, requireIdempotencyKey(key), id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  cancel(@CurrentStaff() me: StaffContext, @Headers('idempotency-key') key: string | undefined, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ReasonDto) {
    return this.orders.cancel(me, requireIdempotencyKey(key), id, dto);
  }
}
