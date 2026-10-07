import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { MovementType, Prisma, ReturnCondition } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { PageQuery } from '../catalog/catalog.dto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { can } from './permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

const PAGE_SIZE = 50;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class StockTarget {
  @ApiProperty() @IsUUID() product_id!: string;
  @ApiProperty() @IsUUID() warehouse_id!: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500) comment?: string;
  @ApiPropertyOptional({ description: 'Только администратор: операция над товаром с учётом по единицам (учёт может разойтись)' })
  @IsOptional()
  @IsBoolean()
  override_unit_tracking?: boolean;
  @ApiPropertyOptional({ description: 'Причина обхода учёта по единицам (обязательно вместе с override_unit_tracking)' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  override_reason?: string;
}

export const UNIT_TRACKED_MESSAGE = 'Товар учитывается по единицам: используйте «Приёмка»';

export class ReceiptDto extends StockTarget {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) qty!: number;
  @ApiPropertyOptional({ description: 'Закупочная цена за единицу, сум (только с правом costs.view)' }) @IsOptional() @IsInt() @Min(0) cost_uzs?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(100) batch_no?: string;
  @ApiPropertyOptional({ example: '2028-06-30' }) @IsOptional() @IsDateString() expiry_date?: string;
}

export class WriteoffDto extends StockTarget {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) qty!: number;
  @ApiProperty({ description: 'Причина (обязательно)' }) @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}

export class AdjustmentDto extends StockTarget {
  @ApiProperty({ description: 'Фактическое количество по пересчёту' }) @IsInt() @Min(0) actual_qty!: number;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}

export class ReturnToStockDto extends StockTarget {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) qty!: number;
  @ApiProperty({ enum: ReturnCondition, description: 'resellable — вернётся в продажу; иначе приходуется и сразу списывается' })
  @IsEnum(ReturnCondition)
  condition!: ReturnCondition;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(500) reason!: string;
}

export class StockQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional({ description: 'true — только товары с остатком на уровне минимума или ниже' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  low_only?: boolean;
}

export class MovementsQuery extends PageQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() product_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() warehouse_id?: string;
  @ApiPropertyOptional({ enum: MovementType }) @IsOptional() @IsEnum(MovementType) type?: MovementType;
}

const note = (reason: string | undefined, comment: string | undefined) => [reason, comment].filter(Boolean).join(' — ') || null;

interface InventoryRow {
  id: string;
  actual_qty: number;
  reserved_qty: number;
}

/**
 * Manual warehouse operations (Master TZ §20). Each one locks the inventory row, refuses to touch
 * reserved units, writes an inventory_movements row (history) and an audit entry.
 */
@Injectable()
export class AdminInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  warehouses() {
    return this.prisma.warehouses.findMany({ orderBy: { name: 'asc' } });
  }

  async stock(q: StockQuery) {
    const rows = await this.prisma.products.findMany({
      where: {
        status: { not: 'archived' },
        ...(q.q && {
          OR: [
            { sku: { contains: q.q, mode: 'insensitive' } },
            { name_ru: { contains: q.q, mode: 'insensitive' } },
            { brand: { contains: q.q, mode: 'insensitive' } },
          ],
        }),
      },
      orderBy: { name_ru: 'asc' },
      include: { inventory: { include: { warehouse: { select: { id: true, name: true } } } } },
    });
    const items = rows
      .map((p) => {
        const actual = p.inventory.reduce((s, i) => s + i.actual_qty, 0);
        const reserved = p.inventory.reduce((s, i) => s + i.reserved_qty, 0);
        return {
          product_id: p.id,
          sku: p.sku,
          name_ru: p.name_ru,
          status: p.status,
          min_stock: p.min_stock,
          unit_tracking: p.unit_tracking,
          actual_qty: actual,
          reserved_qty: reserved,
          available_qty: actual - reserved,
          low: actual - reserved <= p.min_stock,
          warehouses: p.inventory.map((i) => ({
            warehouse: i.warehouse,
            actual_qty: i.actual_qty,
            reserved_qty: i.reserved_qty,
            available_qty: i.actual_qty - i.reserved_qty,
          })),
        };
      })
      .filter((i) => !q.low_only || i.low);
    const start = (q.page - 1) * PAGE_SIZE;
    return { items: items.slice(start, start + PAGE_SIZE), page: q.page, page_size: PAGE_SIZE, total: items.length, total_pages: Math.ceil(items.length / PAGE_SIZE) };
  }

  async movements(q: MovementsQuery) {
    const where: Prisma.inventory_movementsWhereInput = {
      ...(q.product_id && { product_id: q.product_id }),
      ...(q.warehouse_id && { warehouse_id: q.warehouse_id }),
      ...(q.type && { movement_type: q.type }),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.inventory_movements.count({ where }),
      this.prisma.inventory_movements.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (q.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { product: { select: { sku: true, name_ru: true } }, warehouse: { select: { name: true } }, staff: { select: { name: true } } },
      }),
    ]);
    return {
      items: rows.map((m) => ({
        id: m.id,
        created_at: m.created_at,
        type: m.movement_type,
        qty: m.qty,
        product: { id: m.product_id, sku: m.product.sku, name_ru: m.product.name_ru },
        warehouse: m.warehouse.name,
        reason: m.reason,
        reference: m.reference_type ? { type: m.reference_type, id: m.reference_id } : null,
        staff_name: m.staff?.name ?? null,
      })),
      page: q.page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
    };
  }

  receipt(staffId: string | null, dto: ReceiptDto) {
    return this.op(staffId, dto, 'inventory.receipt', async (tx, row) => {
      await tx.inventory.update({ where: { id: row.id }, data: { actual_qty: row.actual_qty + dto.qty } });
      await tx.inventory_batches.create({
        data: {
          product_id: dto.product_id,
          warehouse_id: dto.warehouse_id,
          qty: dto.qty,
          batch_no: dto.batch_no ?? null,
          cost_uzs: dto.cost_uzs == null ? null : BigInt(dto.cost_uzs),
          expiry_date: dto.expiry_date ? new Date(dto.expiry_date) : null,
        },
      });
      await this.move(tx, staffId, dto, 'receipt', dto.qty, note(dto.batch_no ? `Партия ${dto.batch_no}` : 'Приход', dto.comment));
      return { actual_qty: row.actual_qty + dto.qty };
    }, true);
  }

  writeoff(staffId: string, dto: WriteoffDto) {
    return this.op(staffId, dto, 'inventory.writeoff', async (tx, row) => {
      if (row.actual_qty - dto.qty < row.reserved_qty) {
        throw new ConflictException({
          code: 'STOCK_RESERVED',
          message: 'Reserved units cannot be written off',
          available_qty: row.actual_qty - row.reserved_qty,
        });
      }
      await tx.inventory.update({ where: { id: row.id }, data: { actual_qty: row.actual_qty - dto.qty } });
      await this.move(tx, staffId, dto, 'writeoff', dto.qty, note(dto.reason, dto.comment));
      return { actual_qty: row.actual_qty - dto.qty };
    });
  }

  /** Stock count: sets the counted quantity; the movement stores the signed difference. */
  adjustment(staffId: string | null, dto: AdjustmentDto) {
    return this.op(staffId, dto, 'inventory.adjustment', async (tx, row) => {
      if (dto.actual_qty < row.reserved_qty) {
        throw new ConflictException({ code: 'STOCK_RESERVED', message: `${row.reserved_qty} units are reserved by orders`, reserved_qty: row.reserved_qty });
      }
      const delta = dto.actual_qty - row.actual_qty;
      if (delta === 0) throw new BadRequestException({ code: 'NOTHING_TO_ADJUST', message: 'The counted quantity equals the current one' });
      await tx.inventory.update({ where: { id: row.id }, data: { actual_qty: dto.actual_qty } });
      await this.move(tx, staffId, dto, 'adjustment', delta, note(dto.reason, dto.comment));
      return { actual_qty: dto.actual_qty, delta };
    });
  }

  /** Resellable goods go back on sale; anything else is received and written off at once (both recorded). */
  returnToStock(staffId: string, dto: ReturnToStockDto) {
    return this.op(staffId, dto, 'inventory.return_to_stock', async (tx, row) => {
      const reason = note(`Возврат (${dto.condition}): ${dto.reason}`, dto.comment);
      await this.move(tx, staffId, dto, 'return_to_stock', dto.qty, reason);
      if (dto.condition === 'resellable') {
        await tx.inventory.update({ where: { id: row.id }, data: { actual_qty: row.actual_qty + dto.qty } });
        return { actual_qty: row.actual_qty + dto.qty };
      }
      await this.move(tx, staffId, dto, 'writeoff', dto.qty, `Непригоден к продаже (${dto.condition}) после возврата`);
      return { actual_qty: row.actual_qty };
    }, true);
  }

  private async op(
    staffId: string | null,
    dto: StockTarget & object,
    action: string,
    fn: (tx: Prisma.TransactionClient, row: InventoryRow) => Promise<object>,
    createIfMissing = false,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.products.findUnique({ where: { id: dto.product_id } });
      const warehouse = await tx.warehouses.findUnique({ where: { id: dto.warehouse_id } });
      if (!product || !warehouse) throw new BadRequestException({ code: 'UNKNOWN_PRODUCT_OR_WAREHOUSE', message: 'Unknown product or warehouse' });
      // Stage 2B: a unit-tracked product changes only through receiving; admin may override with a reason.
      if (product.unit_tracking) {
        if (!dto.override_unit_tracking) throw new ConflictException({ code: 'UNIT_TRACKED', message: UNIT_TRACKED_MESSAGE });
        if (!dto.override_reason) throw new BadRequestException({ code: 'OVERRIDE_REASON_REQUIRED', message: 'Укажите причину: операция в обход учёта по единицам' });
      }
      if (createIfMissing) {
        await tx.inventory.upsert({
          where: { product_id_warehouse_id: { product_id: dto.product_id, warehouse_id: dto.warehouse_id } },
          create: { product_id: dto.product_id, warehouse_id: dto.warehouse_id },
          update: {},
        });
      }
      const [row] = await tx.$queryRaw<InventoryRow[]>`
        SELECT id, actual_qty, reserved_qty FROM inventory
        WHERE product_id = ${dto.product_id}::uuid AND warehouse_id = ${dto.warehouse_id}::uuid
        FOR UPDATE`;
      if (!row) throw new ConflictException({ code: 'NO_STOCK_ROW', message: 'This product has no stock in this warehouse' });
      const result = await fn(tx, row);
      await this.audit.log(
        { staffId, action, entityType: 'product', entityId: dto.product_id, before: { actual_qty: row.actual_qty, reserved_qty: row.reserved_qty }, after: { ...dto, ...result } },
        tx,
      );
      if (product.unit_tracking) {
        await this.audit.log(
          {
            staffId,
            action: 'inventory.unit_tracking_override',
            entityType: 'product',
            entityId: dto.product_id,
            before: { actual_qty: row.actual_qty },
            after: { operation: action, reason: dto.override_reason, ...result, warning: 'Остаток изменён в обход учёта по единицам: единицы и остаток могли разойтись (см. Склад → Сверка)' },
          },
          tx,
        );
      }
      return { product_id: dto.product_id, warehouse_id: dto.warehouse_id, reserved_qty: row.reserved_qty, ...result };
    });
  }

  private move(tx: Prisma.TransactionClient, staffId: string | null, t: StockTarget, type: MovementType, qty: number, reason: string | null) {
    return tx.inventory_movements.create({
      data: { product_id: t.product_id, warehouse_id: t.warehouse_id, movement_type: type, qty, reason, created_by: staffId },
    });
  }
}

/** Only admin may bypass unit tracking: for other roles the flag is ignored, so they get 409 UNIT_TRACKED. */
function overrideFor<T extends StockTarget>(me: StaffContext, dto: T): T {
  return can(me.staff.role, 'inventory.unit_override') ? dto : { ...dto, override_unit_tracking: undefined, override_reason: undefined };
}

@ApiTags('staff: inventory')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/inventory')
export class AdminInventoryController {
  constructor(private readonly inventory: AdminInventoryService) {}

  @Get('warehouses')
  @RequirePermission('inventory.view')
  warehouses() {
    return this.inventory.warehouses();
  }

  @Get()
  @RequirePermission('inventory.view')
  stock(@Query() q: StockQuery) {
    return this.inventory.stock(q);
  }

  @Get('movements')
  @RequirePermission('inventory.view')
  movements(@Query() q: MovementsQuery) {
    return this.inventory.movements(q);
  }

  @Post('receipt')
  @RequirePermission('inventory.edit')
  receipt(@CurrentStaff() me: StaffContext, @Body() dto: ReceiptDto) {
    // Stage 0: the purchase price is finance; the warehouse receives goods without it (the batch is stored without a price).
    if (dto.cost_uzs != null && !can(me.staff.role, 'costs.view')) {
      throw new ForbiddenException({ code: 'COST_FORBIDDEN', message: `Role ${me.staff.role} cannot enter the purchase price` });
    }
    return this.inventory.receipt(me.staff.id, overrideFor(me, dto));
  }

  @Post('writeoff')
  @RequirePermission('inventory.edit')
  writeoff(@CurrentStaff() me: StaffContext, @Body() dto: WriteoffDto) {
    return this.inventory.writeoff(me.staff.id, overrideFor(me, dto));
  }

  @Post('adjustment')
  @RequirePermission('inventory.edit')
  adjustment(@CurrentStaff() me: StaffContext, @Body() dto: AdjustmentDto) {
    return this.inventory.adjustment(me.staff.id, overrideFor(me, dto));
  }

  @Post('return')
  @RequirePermission('inventory.edit')
  returnToStock(@CurrentStaff() me: StaffContext, @Body() dto: ReturnToStockDto) {
    return this.inventory.returnToStock(me.staff.id, overrideFor(me, dto));
  }
}
