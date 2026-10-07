import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
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
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma, PurchaseSourceType, PurchaseStatus, StaffRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { createHash } from 'crypto';
import { PageQuery } from '../catalog/catalog.dto';
import { stableStringify } from '../common/stable-json';
import { PrismaService } from '../prisma/prisma.service';
import { allocateLineTotals, costQty, derivePurchaseStatus, lineBase, purchaseProgress, remainingQty, unitCostRange } from '../purchases/purchase-cost';
import { auditJson, AuditService } from './audit.service';
import { can } from './permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

type Tx = Prisma.TransactionClient;
const PAGE_SIZE = 50;
const TX = { maxWait: 10_000, timeout: 20_000 };
const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const textOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

// ---------------------------------------------------------------- DTOs

export class PurchaseLineInput {
  @ApiProperty() @IsUUID() product_id!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) ordered_qty!: number;
  @ApiProperty({ minimum: 0, description: 'Цена за штуку по заказу, сум' }) @IsInt() @Min(0) unit_price_original_uzs!: number;
}

export class CreatePurchaseDto {
  @ApiProperty({ enum: PurchaseSourceType }) @IsEnum(PurchaseSourceType) source_type!: PurchaseSourceType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() ozon_account_id?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplier_id?: string | null;
  @ApiPropertyOptional({ example: '0123456789-0001' }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(100) ozon_order_number?: string | null;
  @ApiProperty({ example: '2026-10-08' }) @Matches(DATE, { message: 'purchase_date: YYYY-MM-DD' }) purchase_date!: string;
  @ApiPropertyOptional({ nullable: true, description: 'Сколько реально заплатили, сум' }) @IsOptional() @IsInt() @Min(0) final_actual_total_uzs?: number | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(2000) comment?: string | null;
  @ApiProperty({ type: [PurchaseLineInput] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineInput)
  lines!: PurchaseLineInput[];
}

export class UpdatePurchaseDto {
  @ApiPropertyOptional({ example: '2026-10-08' }) @IsOptional() @Matches(DATE, { message: 'purchase_date: YYYY-MM-DD' }) purchase_date?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(2000) comment?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'null — убрать итоговую сумму (тогда используются цены строк)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  final_actual_total_uzs?: number | null;
}

export class UpdateLineDto {
  @ApiPropertyOptional({ minimum: 1 }) @IsOptional() @IsInt() @Min(1) ordered_qty?: number;
  @ApiPropertyOptional({ minimum: 0 }) @IsOptional() @IsInt() @Min(0) unit_price_original_uzs?: number;
}

export class OzonCancelDto {
  @ApiProperty() @IsUUID() ozon_account_id!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) ozon_order_number!: string;
  @ApiProperty() @IsUUID() product_id!: string;
  @ApiProperty({ minimum: 1, description: 'Сколько штук отменить сейчас (добавляется к уже отменённому)' }) @IsInt() @Min(1) cancelled_qty!: number;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(500) note?: string | null;
}

export class OzonFindQuery {
  @ApiProperty() @IsUUID() ozon_account_id!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) ozon_order_number!: string;
}

export class PurchasesQuery extends PageQuery {
  @ApiPropertyOptional({ enum: PurchaseSourceType }) @IsOptional() @IsEnum(PurchaseSourceType) source_type?: PurchaseSourceType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() ozon_account_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplier_id?: string;
  @ApiPropertyOptional({ enum: PurchaseStatus }) @IsOptional() @IsEnum(PurchaseStatus) status?: PurchaseStatus;
  @ApiPropertyOptional({ example: '2026-10-01' }) @IsOptional() @Matches(DATE) date_from?: string;
  @ApiPropertyOptional({ example: '2026-10-31' }) @IsOptional() @Matches(DATE) date_to?: string;
  @ApiPropertyOptional({ description: 'Поиск по номеру заказа Ozon' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
}

export class CostPreviewLine {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) ordered_qty!: number;
  @ApiPropertyOptional({ minimum: 0 }) @IsOptional() @IsInt() @Min(0) cancelled_qty?: number;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) unit_price_original_uzs!: number;
}

export class CostPreviewDto {
  @ApiProperty({ type: [CostPreviewLine] }) @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => CostPreviewLine) lines!: CostPreviewLine[];
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(0) final_actual_total_uzs?: number | null;
}

// ---------------------------------------------------------------- views

const purchaseInclude = {
  ozon_account: { select: { id: true, name: true } },
  supplier: { select: { id: true, name: true } },
  staff: { select: { name: true } },
  lines: { orderBy: [{ created_at: 'asc' }, { id: 'asc' }], include: { product: { select: { id: true, sku: true, name_ru: true } } } },
} satisfies Prisma.purchasesInclude;
type PurchaseRow = Prisma.purchasesGetPayload<{ include: typeof purchaseInclude }>;
type LineRow = PurchaseRow['lines'][number];

const day = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: bigint | null | undefined) => (v == null ? null : Number(v));

/** Money in the history of a purchase (prices, totals, costs) is shown only with purchases.view_costs. */
export function stripMoney(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMoney);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !/(_uzs$|price|total|cost|allocated)/i.test(k))
        .map(([k, v]) => [k, stripMoney(v)]),
    );
  }
  return value;
}

function lineView(l: LineRow, costs: boolean) {
  return {
    id: l.id,
    product: l.product,
    ordered_qty: l.ordered_qty,
    cancelled_qty: l.cancelled_qty,
    received_qty: l.received_qty,
    remaining_qty: remainingQty(l),
    ...(costs && {
      unit_price_original_uzs: Number(l.unit_price_original_uzs),
      base_total_uzs: Number(lineBase(l)),
      allocated_total_uzs: num(l.allocated_total_uzs),
      unit_cost_uzs: unitCostRange(l.allocated_total_uzs, costQty(l)),
    }),
  };
}

function purchaseView(p: PurchaseRow, costs: boolean) {
  const linesTotal = p.lines.reduce((s, l) => s + lineBase(l), 0n);
  return {
    id: p.id,
    source_type: p.source_type,
    ozon_account: p.ozon_account,
    supplier: p.supplier,
    ozon_order_number: p.ozon_order_number,
    purchase_date: day(p.purchase_date),
    status: p.status,
    comment: p.comment,
    created_by_name: p.staff?.name ?? null,
    created_at: p.created_at,
    updated_at: p.updated_at,
    progress: purchaseProgress(p.lines),
    ...(costs && {
      final_actual_total_uzs: num(p.final_actual_total_uzs),
      lines_total_uzs: Number(linesTotal),
      difference_uzs: p.final_actual_total_uzs == null ? null : Number(p.final_actual_total_uzs - linesTotal),
      // «итоговая сумма не указана, используются цены строк»
      final_total_missing: p.final_actual_total_uzs == null && p.lines.length > 0,
    }),
    lines: p.lines.map((l) => lineView(l, costs)),
  };
}

// ---------------------------------------------------------------- service

/**
 * Stage 2A purchases (Ozon and suppliers). A purchase is never deleted; every change is a purchase_events row
 * (append-only) plus an audit_logs entry; the allocated cost of the lines is recalculated after each change.
 * Stock is not touched here (receiving comes in stage 2B).
 */
@Injectable()
export class AdminPurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: PurchasesQuery, costs: boolean) {
    const and: Prisma.purchasesWhereInput[] = [];
    if (q.source_type) and.push({ source_type: q.source_type });
    if (q.ozon_account_id) and.push({ ozon_account_id: q.ozon_account_id });
    if (q.supplier_id) and.push({ supplier_id: q.supplier_id });
    if (q.status) and.push({ status: q.status });
    if (q.date_from) and.push({ purchase_date: { gte: new Date(`${q.date_from}T00:00:00Z`) } });
    if (q.date_to) and.push({ purchase_date: { lte: new Date(`${q.date_to}T00:00:00Z`) } });
    if (q.q) and.push({ ozon_order_number: { contains: q.q, mode: 'insensitive' } });
    const where: Prisma.purchasesWhereInput = { AND: and };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.purchases.count({ where }),
      this.prisma.purchases.findMany({
        where,
        orderBy: [{ purchase_date: 'desc' }, { created_at: 'desc' }],
        skip: (q.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: purchaseInclude,
      }),
    ]);
    return {
      items: rows.map((p) => {
        const { lines: _lines, ...rest } = purchaseView(p, costs);
        return { ...rest, lines_count: p.lines.length };
      }),
      page: q.page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
    };
  }

  async get(id: string, costs: boolean) {
    const p = await this.prisma.purchases.findUnique({ where: { id }, include: purchaseInclude });
    if (!p) throw new NotFoundException('Purchase not found');
    const events = await this.prisma.purchase_events.findMany({
      where: { purchase_id: id },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      include: { staff: { select: { name: true } } },
    });
    return {
      ...purchaseView(p, costs),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        line_id: e.purchase_line_id,
        qty: e.qty,
        note: e.note,
        staff_name: e.staff?.name ?? null,
        created_at: e.created_at,
        before: costs ? e.before_json : stripMoney(e.before_json),
        after: costs ? e.after_json : stripMoney(e.after_json),
      })),
    };
  }

  /** «Отмена Ozon» step 1: the purchase by account + Ozon order number (case and spaces ignored). */
  async findOzon(q: OzonFindQuery, costs: boolean) {
    const p = await this.findOzonRow(this.prisma, q.ozon_account_id, q.ozon_order_number);
    if (!p) throw new NotFoundException({ code: 'PURCHASE_NOT_FOUND', message: 'Закупка с таким номером Ozon в этом аккаунте не найдена' });
    return this.get(p.id, costs);
  }

  /** Same arithmetic as saving, for the creation form (nothing is written). */
  previewCosts(dto: CostPreviewDto) {
    const lines = dto.lines.map((l) => ({ ordered_qty: l.ordered_qty, cancelled_qty: l.cancelled_qty ?? 0, unit_price_original_uzs: l.unit_price_original_uzs }));
    const allocated = allocateLineTotals(lines, dto.final_actual_total_uzs ?? null);
    const linesTotal = lines.reduce((s, l) => s + lineBase(l), 0n);
    return {
      lines_total_uzs: Number(linesTotal),
      final_actual_total_uzs: dto.final_actual_total_uzs ?? null,
      difference_uzs: dto.final_actual_total_uzs == null ? null : dto.final_actual_total_uzs - Number(linesTotal),
      final_total_missing: dto.final_actual_total_uzs == null,
      lines: lines.map((l, i) => ({
        base_total_uzs: Number(lineBase(l)),
        allocated_total_uzs: Number(allocated[i]),
        unit_cost_uzs: unitCostRange(allocated[i], costQty(l)),
      })),
    };
  }

  /** Creates a purchase exactly once per Idempotency-Key (the same mechanism as order creation). */
  async create(staffId: string, key: string, dto: CreatePurchaseDto): Promise<{ id: string; replayed: boolean }> {
    return this.idempotent('purchase.create', staffId, key, dto, async (tx) => {
      await this.assertSource(tx, dto);
      const productIds = dto.lines.map((l) => l.product_id);
      if (new Set(productIds).size !== productIds.length) {
        throw new BadRequestException({ code: 'DUPLICATE_PRODUCT', message: 'Один товар — одна строка закупки' });
      }
      await this.assertProducts(tx, productIds);
      // Lines are ordered by created_at, and now() is the same for the whole transaction: 1 ms apart keeps
      // the input order (it decides the rounding tie-break, S2A-4).
      const t0 = Date.now();
      const purchase = await tx.purchases.create({
        data: {
          source_type: dto.source_type,
          ozon_account_id: dto.source_type === 'OZON' ? dto.ozon_account_id! : null,
          ozon_order_number: dto.source_type === 'OZON' ? dto.ozon_order_number! : null,
          supplier_id: dto.source_type === 'SUPPLIER' ? dto.supplier_id! : null,
          purchase_date: new Date(`${dto.purchase_date}T00:00:00Z`),
          final_actual_total_uzs: dto.final_actual_total_uzs == null ? null : BigInt(dto.final_actual_total_uzs),
          comment: dto.comment ?? null,
          created_by: staffId,
          lines: {
            create: dto.lines.map((l, i) => ({
              product_id: l.product_id,
              ordered_qty: l.ordered_qty,
              unit_price_original_uzs: BigInt(l.unit_price_original_uzs),
              created_at: new Date(t0 + i),
            })),
          },
        },
        include: purchaseInclude,
      });
      await this.event(tx, purchase.id, 'CREATED', staffId, { after: purchaseView(purchase, true) });
      await this.recalc(tx, purchase.id, staffId);
      await this.audit.log({ staffId, action: 'purchase.created', entityType: 'purchase', entityId: purchase.id, after: purchaseView(purchase, true) }, tx);
      return { id: purchase.id };
    });
  }

  /** Date, comment and the final actual total (null = use the line prices). */
  async update(staffId: string, id: string, dto: UpdatePurchaseDto) {
    await this.inPurchaseTx(id, async (tx, before) => {
      const data: Prisma.purchasesUncheckedUpdateInput = {};
      const was: Record<string, unknown> = {};
      const now: Record<string, unknown> = {};
      if (dto.purchase_date !== undefined && dto.purchase_date !== day(before.purchase_date)) {
        data.purchase_date = new Date(`${dto.purchase_date}T00:00:00Z`);
        [was.purchase_date, now.purchase_date] = [day(before.purchase_date), dto.purchase_date];
      }
      if (dto.comment !== undefined && dto.comment !== before.comment) {
        data.comment = dto.comment;
        [was.comment, now.comment] = [before.comment, dto.comment];
      }
      const finalChanged = dto.final_actual_total_uzs !== undefined && num(before.final_actual_total_uzs) !== dto.final_actual_total_uzs;
      if (finalChanged) data.final_actual_total_uzs = dto.final_actual_total_uzs == null ? null : BigInt(dto.final_actual_total_uzs);
      if (!Object.keys(data).length) return;
      await tx.purchases.update({ where: { id }, data });
      if (Object.keys(now).length) await this.event(tx, id, 'EDITED', staffId, { before: was, after: now });
      if (finalChanged) {
        await this.event(tx, id, 'FINAL_TOTAL_SET', staffId, {
          before: { final_actual_total_uzs: num(before.final_actual_total_uzs) },
          after: { final_actual_total_uzs: dto.final_actual_total_uzs },
        });
      }
      await this.recalc(tx, id, staffId);
      await this.auditChange(tx, staffId, 'purchase.updated', id, before);
    });
    return id;
  }

  async addLine(staffId: string, id: string, dto: PurchaseLineInput) {
    await this.inPurchaseTx(id, async (tx, before) => {
      if (before.lines.some((l) => l.product_id === dto.product_id)) {
        throw new ConflictException({ code: 'LINE_EXISTS', message: 'Этот товар уже есть в закупке — измените его строку' });
      }
      await this.assertProducts(tx, [dto.product_id]);
      const line = await tx.purchase_lines.create({
        data: { purchase_id: id, product_id: dto.product_id, ordered_qty: dto.ordered_qty, unit_price_original_uzs: BigInt(dto.unit_price_original_uzs) },
      });
      await this.event(tx, id, 'LINE_ADDED', staffId, { lineId: line.id, qty: dto.ordered_qty, after: { product_id: dto.product_id, ordered_qty: dto.ordered_qty, unit_price_original_uzs: dto.unit_price_original_uzs } });
      await this.recalc(tx, id, staffId);
      await this.auditChange(tx, staffId, 'purchase.line_added', id, before);
    });
    return id;
  }

  /** Ordered quantity may not go below cancelled + received. */
  async updateLine(staffId: string, id: string, lineId: string, dto: UpdateLineDto) {
    await this.inPurchaseTx(id, async (tx, before) => {
      const line = before.lines.find((l) => l.id === lineId);
      if (!line) throw new NotFoundException({ code: 'LINE_NOT_FOUND', message: 'Строка закупки не найдена' });
      if (dto.ordered_qty !== undefined && dto.ordered_qty < line.cancelled_qty + line.received_qty) {
        throw new ConflictException({
          code: 'QTY_BELOW_CANCELLED_RECEIVED',
          message: `Заказано не может быть меньше, чем уже отменено и получено (${line.cancelled_qty + line.received_qty})`,
          minimum: line.cancelled_qty + line.received_qty,
        });
      }
      const data: Prisma.purchase_linesUpdateInput = {};
      if (dto.ordered_qty !== undefined && dto.ordered_qty !== line.ordered_qty) data.ordered_qty = dto.ordered_qty;
      if (dto.unit_price_original_uzs !== undefined && BigInt(dto.unit_price_original_uzs) !== line.unit_price_original_uzs) {
        data.unit_price_original_uzs = BigInt(dto.unit_price_original_uzs);
      }
      if (!Object.keys(data).length) return;
      await tx.purchase_lines.update({ where: { id: lineId }, data });
      await this.event(tx, id, 'LINE_EDITED', staffId, {
        lineId,
        before: { ordered_qty: line.ordered_qty, unit_price_original_uzs: Number(line.unit_price_original_uzs) },
        after: { ordered_qty: dto.ordered_qty ?? line.ordered_qty, unit_price_original_uzs: dto.unit_price_original_uzs ?? Number(line.unit_price_original_uzs) },
      });
      await this.recalc(tx, id, staffId);
      await this.auditChange(tx, staffId, 'purchase.line_updated', id, before);
    });
    return id;
  }

  /** Only a line nothing was received for; at least one line stays (cancel the quantities instead). */
  async removeLine(staffId: string, id: string, lineId: string) {
    await this.inPurchaseTx(id, async (tx, before) => {
      const line = before.lines.find((l) => l.id === lineId);
      if (!line) throw new NotFoundException({ code: 'LINE_NOT_FOUND', message: 'Строка закупки не найдена' });
      if (line.received_qty > 0) throw new ConflictException({ code: 'LINE_HAS_RECEIVED', message: 'По этой строке уже получен товар — убрать её нельзя' });
      if (before.lines.length === 1) {
        throw new ConflictException({ code: 'LAST_LINE', message: 'В закупке должна остаться хотя бы одна строка; чтобы закупки не было, отмените её количество' });
      }
      await tx.purchase_lines.delete({ where: { id: lineId } });
      await this.event(tx, id, 'LINE_REMOVED', staffId, {
        lineId,
        qty: line.ordered_qty,
        before: { product_id: line.product_id, sku: line.product.sku, ordered_qty: line.ordered_qty, unit_price_original_uzs: Number(line.unit_price_original_uzs) },
      });
      await this.recalc(tx, id, staffId);
      await this.auditChange(tx, staffId, 'purchase.line_removed', id, before);
    });
    return id;
  }

  /**
   * «Отмена Ozon»: account + Ozon order number -> line of the product -> cancelled_qty is added to what was
   * cancelled before. Not more than ordered - cancelled - received. Exactly once per Idempotency-Key.
   */
  async cancelOzon(staffId: string, key: string, dto: OzonCancelDto): Promise<{ id: string; replayed: boolean }> {
    return this.idempotent('purchase.cancel', staffId, key, dto, async (tx) => {
      const found = await this.findOzonRow(tx, dto.ozon_account_id, dto.ozon_order_number);
      if (!found) throw new NotFoundException({ code: 'PURCHASE_NOT_FOUND', message: 'Закупка с таким номером Ozon в этом аккаунте не найдена' });
      const before = await this.lockPurchase(tx, found.id);
      const line = before.lines.find((l) => l.product_id === dto.product_id);
      if (!line) throw new NotFoundException({ code: 'LINE_NOT_FOUND', message: 'Этого товара нет в закупке' });
      const available = remainingQty(line);
      if (dto.cancelled_qty > available) {
        throw new ConflictException({ code: 'CANCEL_TOO_MUCH', message: `Можно отменить не больше ${available} шт.`, available });
      }
      const cancelled = line.cancelled_qty + dto.cancelled_qty;
      await tx.purchase_lines.update({ where: { id: line.id }, data: { cancelled_qty: cancelled } });
      await this.event(tx, before.id, 'CANCELLED', staffId, {
        lineId: line.id,
        qty: dto.cancelled_qty,
        note: dto.note ?? null,
        before: { sku: line.product.sku, ordered_qty: line.ordered_qty, cancelled_qty: line.cancelled_qty, remaining_qty: available },
        after: { sku: line.product.sku, ordered_qty: line.ordered_qty, cancelled_qty: cancelled, remaining_qty: available - dto.cancelled_qty },
      });
      await this.recalc(tx, before.id, staffId);
      await this.auditChange(tx, staffId, 'purchase.cancelled', before.id, before, { product_id: dto.product_id, cancelled_qty: dto.cancelled_qty });
      return { id: before.id };
    });
  }

  // ---------------------------------------------------------------- internals

  /** allocated_total_uzs of every line and the status, after any change; a RECALCULATED event when it moved. */
  private async recalc(tx: Tx, id: string, staffId: string) {
    const p = await tx.purchases.findUniqueOrThrow({ where: { id }, include: purchaseInclude });
    const allocated = allocateLineTotals(p.lines, p.final_actual_total_uzs);
    const before: Record<string, number | null> = {};
    const after: Record<string, number> = {};
    for (const [i, l] of p.lines.entries()) {
      if (l.allocated_total_uzs === allocated[i]) continue;
      await tx.purchase_lines.update({ where: { id: l.id }, data: { allocated_total_uzs: allocated[i] } });
      before[l.product.sku] = num(l.allocated_total_uzs);
      after[l.product.sku] = Number(allocated[i]);
    }
    if (Object.keys(after).length) await this.event(tx, id, 'RECALCULATED', staffId, { before: { allocated_total_uzs: before }, after: { allocated_total_uzs: after } });
    const status = derivePurchaseStatus(p.lines);
    if (status !== p.status) await tx.purchases.update({ where: { id }, data: { status } });
  }

  private event(
    tx: Tx,
    purchaseId: string,
    type: string,
    staffId: string,
    e: { lineId?: string; qty?: number; note?: string | null; before?: unknown; after?: unknown },
  ) {
    return tx.purchase_events.create({
      data: {
        purchase_id: purchaseId,
        purchase_line_id: e.lineId ?? null,
        type,
        qty: e.qty ?? null,
        note: e.note ?? null,
        before_json: e.before === undefined ? Prisma.JsonNull : auditJson(e.before),
        after_json: e.after === undefined ? Prisma.JsonNull : auditJson(e.after),
        created_by: staffId,
      },
    });
  }

  private async auditChange(tx: Tx, staffId: string, action: string, id: string, before: PurchaseRow, extra?: object) {
    const after = await tx.purchases.findUniqueOrThrow({ where: { id }, include: purchaseInclude });
    await this.audit.log({ staffId, action, entityType: 'purchase', entityId: id, before: purchaseView(before, true), after: { ...purchaseView(after, true), ...extra } }, tx);
  }

  private async lockPurchase(tx: Tx, id: string): Promise<PurchaseRow> {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM purchases WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked.length) throw new NotFoundException('Purchase not found');
    return tx.purchases.findUniqueOrThrow({ where: { id }, include: purchaseInclude });
  }

  private inPurchaseTx(id: string, fn: (tx: Tx, before: PurchaseRow) => Promise<void>) {
    return this.prisma.$transaction(async (tx) => fn(tx, await this.lockPurchase(tx, id)), TX);
  }

  private findOzonRow(db: Tx | PrismaService, accountId: string, orderNumber: string) {
    return db.purchases.findFirst({
      where: { source_type: 'OZON', ozon_account_id: accountId, ozon_order_number: { equals: orderNumber.trim(), mode: 'insensitive' } },
      select: { id: true },
    });
  }

  /** OZON: an active account and an order number unique in it; SUPPLIER: an active supplier, no Ozon fields. */
  private async assertSource(tx: Tx, dto: CreatePurchaseDto) {
    if (dto.source_type === 'OZON') {
      if (!dto.ozon_account_id || !dto.ozon_order_number) {
        throw new BadRequestException({ code: 'OZON_FIELDS_REQUIRED', message: 'Для закупки Ozon нужны аккаунт и номер заказа Ozon' });
      }
      if (dto.supplier_id) throw new BadRequestException({ code: 'SUPPLIER_NOT_ALLOWED', message: 'У закупки Ozon нет поставщика' });
      const account = await tx.ozon_accounts.findUnique({ where: { id: dto.ozon_account_id } });
      if (!account || account.status !== 'active') throw new BadRequestException({ code: 'UNKNOWN_OZON_ACCOUNT', message: 'Ozon-аккаунт не найден или в архиве' });
      if (await this.findOzonRow(tx, dto.ozon_account_id, dto.ozon_order_number)) {
        throw new ConflictException({ code: 'OZON_ORDER_EXISTS', message: `Заказ Ozon ${dto.ozon_order_number} уже есть в аккаунте «${account.name}»` });
      }
    } else {
      if (!dto.supplier_id) throw new BadRequestException({ code: 'SUPPLIER_REQUIRED', message: 'Для закупки у поставщика выберите поставщика' });
      if (dto.ozon_account_id || dto.ozon_order_number) {
        throw new BadRequestException({ code: 'OZON_FIELDS_NOT_ALLOWED', message: 'Ozon-аккаунт и номер заказа — только для закупок Ozon' });
      }
      const supplier = await tx.suppliers.findUnique({ where: { id: dto.supplier_id } });
      if (!supplier || supplier.status !== 'active') throw new BadRequestException({ code: 'UNKNOWN_SUPPLIER', message: 'Поставщик не найден или в архиве' });
    }
  }

  private async assertProducts(tx: Tx, ids: string[]) {
    const found = await tx.products.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, sku: true } });
    if (found.length !== new Set(ids).size) throw new BadRequestException({ code: 'UNKNOWN_PRODUCT', message: 'Товар не найден' });
    const archived = found.filter((p) => p.status === 'archived');
    if (archived.length) throw new ConflictException({ code: 'PRODUCT_ARCHIVED', message: `Товар в архиве: ${archived.map((p) => p.sku).join(', ')}` });
  }

  /**
   * The same exactly-once mechanism as order creation: the key row is inserted first in the transaction, a
   * parallel duplicate waits on the unique index and then gets the stored answer; a failed attempt frees the key.
   */
  private async idempotent(scope: string, staffId: string, idempotencyKey: string, dto: object, fn: (tx: Tx) => Promise<{ id: string }>) {
    const key = `staff:${staffId}:${scope}:${idempotencyKey}`;
    const requestHash = createHash('sha256').update(stableStringify(dto)).digest('hex');
    const replay = (row: { request_hash: string; response_json: Prisma.JsonValue }) => {
      if (row.request_hash !== requestHash) {
        throw new UnprocessableEntityException({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used with a different request' });
      }
      if (!row.response_json) throw new ConflictException({ code: 'REQUEST_IN_PROGRESS', message: 'The same request is still being processed' });
      return { id: (row.response_json as { id: string }).id, replayed: true };
    };
    const existing = await this.prisma.idempotency_keys.findUnique({ where: { key } });
    if (existing) return replay(existing);
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.idempotency_keys.create({ data: { key, scope, request_hash: requestHash, expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS) } });
        const res = await fn(tx);
        await tx.idempotency_keys.update({ where: { key }, data: { response_json: res } });
        return res;
      }, TX);
      return { ...result, replayed: false };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const row = await this.prisma.idempotency_keys.findUnique({ where: { key } });
        if (row) return replay(row);
        // Not the key: the unique Ozon order number of the account (two different requests at once).
        throw new ConflictException({ code: 'OZON_ORDER_EXISTS', message: 'Такой заказ Ozon уже есть в этом аккаунте' });
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- controller

const costsFor = (role: StaffRole) => can(role, 'purchases.view_costs');

function requireKey(key: string | undefined) {
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Header Idempotency-Key (8-128 chars) is required' });
  }
  return key;
}

@ApiTags('staff: purchases')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/purchases')
export class AdminPurchasesController {
  constructor(private readonly purchases: AdminPurchasesService) {}

  @Get()
  @RequirePermission('purchases.view')
  list(@CurrentStaff() me: StaffContext, @Query() q: PurchasesQuery) {
    return this.purchases.list(q, costsFor(me.staff.role));
  }

  @Get('find-ozon')
  @RequirePermission('purchases.view')
  findOzon(@CurrentStaff() me: StaffContext, @Query() q: OzonFindQuery) {
    return this.purchases.findOzon(q, costsFor(me.staff.role));
  }

  @Post('cost-preview')
  @HttpCode(200)
  @RequirePermission('purchases.view_costs')
  preview(@Body() dto: CostPreviewDto) {
    return this.purchases.previewCosts(dto);
  }

  @Post('cancel')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async cancel(@CurrentStaff() me: StaffContext, @Headers('idempotency-key') key: string | undefined, @Body() dto: OzonCancelDto) {
    const { id } = await this.purchases.cancelOzon(me.staff.id, requireKey(key), dto);
    return this.purchases.get(id, costsFor(me.staff.role));
  }

  @Get(':id')
  @RequirePermission('purchases.view')
  get(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.purchases.get(id, costsFor(me.staff.role));
  }

  @Post()
  @RequirePermission('purchases.manage')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Один ключ на одну попытку создания' })
  async create(@CurrentStaff() me: StaffContext, @Headers('idempotency-key') key: string | undefined, @Body() dto: CreatePurchaseDto) {
    const { id } = await this.purchases.create(me.staff.id, requireKey(key), dto);
    return this.purchases.get(id, costsFor(me.staff.role));
  }

  @Patch(':id')
  @RequirePermission('purchases.manage')
  async update(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdatePurchaseDto) {
    await this.purchases.update(me.staff.id, id, dto);
    return this.purchases.get(id, costsFor(me.staff.role));
  }

  @Post(':id/lines')
  @RequirePermission('purchases.manage')
  async addLine(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PurchaseLineInput) {
    await this.purchases.addLine(me.staff.id, id, dto);
    return this.purchases.get(id, costsFor(me.staff.role));
  }

  @Patch(':id/lines/:lineId')
  @RequirePermission('purchases.manage')
  async updateLine(
    @CurrentStaff() me: StaffContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('lineId', new ParseUUIDPipe()) lineId: string,
    @Body() dto: UpdateLineDto,
  ) {
    await this.purchases.updateLine(me.staff.id, id, lineId, dto);
    return this.purchases.get(id, costsFor(me.staff.role));
  }

  @Delete(':id/lines/:lineId')
  @RequirePermission('purchases.manage')
  async removeLine(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('lineId', new ParseUUIDPipe()) lineId: string) {
    await this.purchases.removeLine(me.staff.id, id, lineId);
    return this.purchases.get(id, costsFor(me.staff.role));
  }
}
