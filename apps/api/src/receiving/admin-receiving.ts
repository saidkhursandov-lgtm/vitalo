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
  Post,
  Query,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma, ReceivingSessionStatus, StaffRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { requireIdempotencyKey, runIdempotent } from '../common/idempotency';
import { tashkentDateString } from '../common/tashkent';
import { StockService } from '../inventory/stock.service';
import { PrismaService } from '../prisma/prisma.service';
import { costQty, derivePurchaseStatus, lineBase, remainingQty } from '../purchases/purchase-cost';
import { auditJson, AuditService } from '../staff/audit.service';
import { can } from '../staff/permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from '../staff/staff-auth';
import { checkExpiryGroups, distribute, groupExpiries, lineUnitCosts, ruDay, unitExpiries } from './receiving-math';
import { createUnits, moveUnits, NewUnit, reassignLineUnitCosts, unitInclude, unitView } from './units';

type Tx = Prisma.TransactionClient;
const TX = { maxWait: 10_000, timeout: 60_000 };
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
export const OPENING_REASON = 'Начальный остаток по пересчёту, лист пользователя';

// ---------------------------------------------------------------- DTOs

export class StartSessionDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() ozon_account_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() supplier_id?: string;
}

export class ExpectedQuery extends StartSessionDto {}

export class ExpiryGroupInput {
  @ApiProperty({ example: '31.12.2027', description: 'Срок годности ДД.ММ.ГГГГ' }) @Transform(trim) @IsString() @MaxLength(10) expiry!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(10_000) qty!: number;
}

export class AcceptDto {
  @ApiProperty() @IsUUID() product_id!: string;
  @ApiProperty({ minimum: 1, description: 'Сколько банок пришло фактически' }) @IsInt() @Min(1) @Max(10_000) qty!: number;
  @ApiProperty({ type: [ExpiryGroupInput], description: 'Сроки годности: сумма количеств = qty' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ExpiryGroupInput)
  expiry_groups!: ExpiryGroupInput[];
  @ApiPropertyOptional({ description: 'Да, срок годности меньше 90 дней — принять' }) @IsOptional() @IsBoolean() confirm_short_expiry?: boolean;
  @ApiPropertyOptional({ description: 'Да, пришло больше, чем ожидалось — принять с расхождением' }) @IsOptional() @IsBoolean() confirm_over_expected?: boolean;
}

export class CancelSessionDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500) reason?: string;
}

export class SessionsQuery {
  @ApiPropertyOptional({ enum: ReceivingSessionStatus, default: 'OPEN' }) @IsOptional() @IsEnum(ReceivingSessionStatus) status?: ReceivingSessionStatus;
}

// ---------------------------------------------------------------- helpers

const sessionInclude = {
  ozon_account: { select: { id: true, name: true } },
  supplier: { select: { id: true, name: true } },
  staff: { select: { name: true } },
} satisfies Prisma.receiving_sessionsInclude;
type SessionRow = Prisma.receiving_sessionsGetPayload<{ include: typeof sessionInclude }>;

function sourceOf(s: SessionRow) {
  if (s.type === 'OPENING_BALANCE') return { type: 'OPENING_BALANCE' as const, id: null, name: 'Начальный остаток' };
  if (s.ozon_account) return { type: 'OZON' as const, id: s.ozon_account.id, name: s.ozon_account.name };
  return { type: 'SUPPLIER' as const, id: s.supplier?.id ?? null, name: s.supplier?.name ?? '—' };
}

/** PURCHASE source of a request / session: exactly one of an Ozon account or a supplier. */
function sourceWhere(src: { ozon_account_id?: string | null; supplier_id?: string | null }): Prisma.purchasesWhereInput {
  if (!!src.ozon_account_id === !!src.supplier_id) {
    throw new BadRequestException({ code: 'SOURCE_REQUIRED', message: 'Выберите один источник: Ozon-аккаунт или поставщика' });
  }
  return src.ozon_account_id ? { source_type: 'OZON', ozon_account_id: src.ozon_account_id } : { source_type: 'SUPPLIER', supplier_id: src.supplier_id! };
}

const expiryCode: Record<string, string> = {
  EXPIRY_INVALID: 'Срок годности: укажите дату в формате ДД.ММ.ГГГГ',
  EXPIRY_IN_PAST: 'Срок годности уже прошёл — такой товар не принимаем',
  EXPIRY_QTY_MISMATCH: 'Сумма количеств по срокам годности должна быть равна принятому количеству',
};

// ---------------------------------------------------------------- service

/**
 * Stage 2B receiving. A session belongs to one source (Ozon account or supplier) and collects units in status
 * RECEIVED; «Завершить» moves them to IN_STOCK, adds them to purchase_lines.received_qty and to the stock
 * (StockService, receipt movement with reference = session) in ONE transaction, exactly once.
 * The opening balance session (created by npm run import:opening-stock) is completed here too, by admin only.
 */
@Injectable()
export class AdminReceivingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
  ) {}

  /** Active Ozon accounts and suppliers with how many units are still expected, and the open session if any. */
  async sources() {
    const [accounts, suppliers, purchases, open] = await Promise.all([
      this.prisma.ozon_accounts.findMany({ where: { status: 'active' }, orderBy: { name: 'asc' } }),
      this.prisma.suppliers.findMany({ where: { status: 'active' }, orderBy: { name: 'asc' } }),
      this.prisma.purchases.findMany({ where: { status: 'EXPECTED' }, select: { ozon_account_id: true, supplier_id: true, lines: true } }),
      this.prisma.receiving_sessions.findMany({ where: { status: 'OPEN', type: 'PURCHASE' }, select: { id: true, ozon_account_id: true, supplier_id: true } }),
    ]);
    const expected = new Map<string, number>();
    for (const p of purchases) {
      const key = p.ozon_account_id ?? p.supplier_id!;
      expected.set(key, (expected.get(key) ?? 0) + p.lines.reduce((s, l) => s + remainingQty(l), 0));
    }
    const view = (id: string, name: string) => ({
      id,
      name,
      expected_qty: expected.get(id) ?? 0,
      open_session_id: open.find((s) => s.ozon_account_id === id || s.supplier_id === id)?.id ?? null,
    });
    return { ozon_accounts: accounts.map((a) => view(a.id, a.name)), suppliers: suppliers.map((s) => view(s.id, s.name)) };
  }

  /**
   * «Ожидаемые позиции» of a source: per SKU what is still expected over all its EXPECTED purchases, minus what is
   * already accepted in the open session. `full` (admin) also gets the purchases behind each SKU.
   */
  async expected(src: ExpectedQuery, full: boolean) {
    const lines = await this.sourceLines(this.prisma, src);
    const pending = await this.pendingByLine(this.prisma, lines.map((l) => l.id));
    const items = new Map<string, {
      product: { id: string; sku: string; name_ru: string };
      remaining_qty: number;
      accepted_qty: number;
      purchases: { id: string; ozon_order_number: string | null; purchase_date: string; remaining_qty: number }[];
    }>();
    for (const l of lines) {
      const it = items.get(l.product_id) ?? {
        product: { id: l.product.id, sku: l.product.sku, name_ru: l.product.name_ru },
        remaining_qty: 0,
        accepted_qty: 0,
        purchases: [],
      };
      it.remaining_qty += remainingQty(l);
      it.accepted_qty += pending.get(l.id) ?? 0;
      if (remainingQty(l) > 0) {
        it.purchases.push({ id: l.purchase.id, ozon_order_number: l.purchase.ozon_order_number, purchase_date: l.purchase.purchase_date.toISOString().slice(0, 10), remaining_qty: remainingQty(l) });
      }
      items.set(l.product_id, it);
    }
    return {
      items: [...items.values()]
        .filter((i) => i.remaining_qty > 0 || i.accepted_qty > 0)
        .map(({ purchases, ...i }) => ({ ...i, open_qty: Math.max(0, i.remaining_qty - i.accepted_qty), ...(full && { purchases }) })),
    };
  }

  async listSessions(q: SessionsQuery) {
    const rows = await this.prisma.receiving_sessions.findMany({
      where: { status: q.status ?? 'OPEN' },
      orderBy: { created_at: 'desc' },
      take: 100,
      include: { ...sessionInclude, _count: { select: { units: true } } },
    });
    return rows.map((s) => ({
      id: s.id,
      type: s.type,
      status: s.status,
      source: sourceOf(s),
      created_by_name: s.staff?.name ?? null,
      created_at: s.created_at,
      completed_at: s.completed_at,
      units_count: s._count.units,
    }));
  }

  /** «Начать приёмку»: the open session of the source, or a new one (at most one OPEN per source). */
  async start(staffId: string, dto: StartSessionDto) {
    sourceWhere(dto);
    const src = dto.ozon_account_id
      ? await this.prisma.ozon_accounts.findUnique({ where: { id: dto.ozon_account_id } })
      : await this.prisma.suppliers.findUnique({ where: { id: dto.supplier_id! } });
    if (!src || src.status !== 'active') throw new BadRequestException({ code: 'UNKNOWN_SOURCE', message: 'Источник не найден или в архиве' });
    const where = dto.ozon_account_id ? { ozon_account_id: dto.ozon_account_id } : { supplier_id: dto.supplier_id! };
    const open = await this.prisma.receiving_sessions.findFirst({ where: { ...where, status: 'OPEN' } });
    if (open) return open.id;
    try {
      const s = await this.prisma.receiving_sessions.create({ data: { type: 'PURCHASE', ...where, created_by: staffId } });
      await this.audit.log({ staffId, action: 'receiving.started', entityType: 'receiving_session', entityId: s.id, after: { source: src.name } });
      return s.id;
    } catch (e) {
      // Two «Начать» at once: the partial unique index keeps one OPEN session per source.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return (await this.prisma.receiving_sessions.findFirstOrThrow({ where: { ...where, status: 'OPEN' } })).id;
      }
      throw e;
    }
  }

  async get(id: string, full: boolean) {
    const s = await this.prisma.receiving_sessions.findUnique({ where: { id }, include: sessionInclude });
    if (!s) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Приёмка не найдена' });
    const [lines, units] = await Promise.all([
      this.prisma.receiving_session_lines.findMany({
        where: { session_id: id },
        orderBy: { created_at: 'asc' },
        include: { product: { select: { id: true, sku: true, name_ru: true } }, purchase_line: { include: { purchase: true } } },
      }),
      this.prisma.physical_units.findMany({ where: { receiving_session_id: id }, orderBy: { seq: 'asc' }, include: unitInclude }),
    ]);
    const live = units.filter((u) => u.status !== 'VOIDED');
    return {
      id: s.id,
      type: s.type,
      status: s.status,
      source: sourceOf(s),
      created_by_name: s.staff?.name ?? null,
      created_at: s.created_at,
      completed_at: s.completed_at,
      lines: lines.map((l) => ({
        id: l.id,
        product: l.product,
        qty: l.qty,
        expiry_date_groups: l.expiry_date_groups,
        discrepancy_qty: l.discrepancy_qty,
        created_at: l.created_at,
        ...(full &&
          l.purchase_line && {
            purchase: { id: l.purchase_line.purchase.id, ozon_order_number: l.purchase_line.purchase.ozon_order_number, purchase_date: l.purchase_line.purchase.purchase_date.toISOString().slice(0, 10) },
          }),
      })),
      units: units.map((u) => unitView(u, full)),
      summary: {
        units: live.length,
        printed: live.filter((u) => u.label_print_count > 0).length,
        discrepancy_qty: lines.reduce((sum, l) => sum + (l.discrepancy_qty ?? 0), 0),
      },
      label_warnings: [] as string[], // the 58×40 label has no composition: nothing blocks the «Этикетки» step
    };
  }

  /**
   * «Создать Physical ID»: N units of one SKU with their expiry dates, spread over the purchases of the source
   * (oldest purchase first, then line position). Above everything expected -> discrepancy on the last line
   * (needs confirm_over_expected); an expiry under 90 days needs confirm_short_expiry. Exactly once per key.
   */
  async accept(staffId: string, sessionId: string, key: string, dto: AcceptDto) {
    const today = tashkentDateString(new Date());
    const checked = checkExpiryGroups(dto.expiry_groups, dto.qty, today);
    if ('problem' in checked) throw new BadRequestException({ ...checked.problem, message: expiryCode[checked.problem.code] });
    if (checked.short.length && !dto.confirm_short_expiry) {
      throw new ConflictException({
        code: 'SHORT_EXPIRY',
        message: `Срок годности меньше 90 дней: ${checked.short.map((g) => `${ruDay(g.expiry)} (${g.qty} шт.)`).join(', ')}. Всё равно принять?`,
        groups: checked.short,
      });
    }
    return runIdempotent(this.prisma, { scope: 'receiving.accept', staffId, key, request: { sessionId, ...dto } }, async (tx) => {
      const session = await this.lockSession(tx, sessionId);
      if (session.status !== 'OPEN') throw new ConflictException({ code: 'SESSION_NOT_OPEN', message: 'Эта приёмка уже завершена или отменена' });
      if (session.type !== 'PURCHASE') throw new ConflictException({ code: 'WRONG_SESSION_TYPE', message: 'В приёмку начального остатка товары добавляются только скриптом' });
      const product = await tx.products.findUnique({ where: { id: dto.product_id } });
      if (!product || product.status === 'archived') throw new BadRequestException({ code: 'UNKNOWN_PRODUCT', message: 'Товар не найден или в архиве' });

      const lines = (await this.sourceLines(tx, session)).filter((l) => l.product_id === dto.product_id);
      if (!lines.length) throw new ConflictException({ code: 'NOT_EXPECTED', message: `${product.sku} нет в ожидаемых закупках этого источника` });
      const pending = await this.pendingByLine(tx, lines.map((l) => l.id));
      const open = lines.map((l) => ({ open: remainingQty(l) - (pending.get(l.id) ?? 0) }));
      const expectedNow = open.reduce((s, l) => s + Math.max(0, l.open), 0);
      const parts = distribute(dto.qty, open);
      const over = parts.reduce((s, p) => s + p.over, 0);
      if (over > 0 && !dto.confirm_over_expected) {
        throw new ConflictException({
          code: 'OVER_EXPECTED',
          message: `Ожидалось ${expectedNow} шт., принимаете ${dto.qty}: ${over} шт. сверх ожидаемого будут записаны как расхождение. Принять?`,
          expected_qty: expectedNow,
          over_qty: over,
        });
      }

      // Units in order: expiry dates (earliest first) go to the oldest purchases first.
      const days = unitExpiries(checked.groups);
      const units: NewUnit[] = [];
      let cursor = 0;
      for (const part of parts) {
        const line = lines[part.index];
        const already = await tx.physical_units.count({ where: { purchase_line_id: line.id, status: { not: 'VOIDED' } } });
        const costs = lineUnitCosts(line.allocated_total_uzs ?? lineBase(line), costQty(line), already + part.qty).slice(already);
        const partDays = days.slice(cursor, cursor + part.qty);
        cursor += part.qty;
        partDays.forEach((expiry, k) => units.push({ product_id: dto.product_id, purchase_id: line.purchase_id, purchase_line_id: line.id, cost: costs[k], expiry }));
        await tx.receiving_session_lines.create({
          data: {
            session_id: session.id,
            product_id: dto.product_id,
            purchase_line_id: line.id,
            qty: part.qty,
            expiry_date_groups: auditJson(groupExpiries(partDays)),
            discrepancy_qty: part.over || null,
          },
        });
        if (part.over) {
          await tx.purchase_events.create({
            data: {
              purchase_id: line.purchase_id,
              purchase_line_id: line.id,
              type: 'DISCREPANCY',
              qty: part.over,
              note: `Приёмка: пришло на ${part.over} шт. больше ожидаемого`,
              after_json: { sku: product.sku, accepted_qty: part.qty, over_qty: part.over },
              created_by: staffId,
            },
          });
        }
      }
      const created = await createUnits(tx, session.id, units, staffId);
      await this.audit.log(
        {
          staffId,
          action: 'receiving.accepted',
          entityType: 'receiving_session',
          entityId: session.id,
          after: { product_id: dto.product_id, sku: product.sku, qty: dto.qty, expiry_groups: checked.groups, over_qty: over, physical_ids: created.map((c) => c.physical_id) },
        },
        tx,
      );
      return {
        id: session.id,
        physical_ids: created.map((c) => c.physical_id),
        warnings: [
          ...(over ? [`Расхождение: принято на ${over} шт. больше ожидаемого`] : []),
        ],
      };
    });
  }

  /**
   * «Завершить приёмку»: RECEIVED -> IN_STOCK, received quantities of the purchases, statuses, stock — in one
   * transaction. Repeating (same or another key) changes nothing and answers with the completed session.
   */
  async complete(staffId: string, role: StaffRole, sessionId: string, key: string): Promise<{ replayed: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const session = await this.lockSession(tx, sessionId);
      if (session.type === 'OPENING_BALANCE' && !can(role, 'receiving.opening')) {
        throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE', message: 'Начальный остаток завершает только администратор' });
      }
      if (session.status === 'COMPLETED') return { replayed: true };
      if (session.status === 'CANCELLED') throw new ConflictException({ code: 'SESSION_CANCELLED', message: 'Эта приёмка отменена' });
      if (await tx.receiving_sessions.findUnique({ where: { completion_key: key } })) {
        throw new UnprocessableEntityException({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key already completed another receiving' });
      }
      const units = await moveUnits(tx, { receiving_session_id: session.id }, 'RECEIVED', 'IN_STOCK', {
        type: 'IN_STOCK',
        referenceType: 'receiving_session',
        referenceId: session.id,
        staffId,
      });
      if (!units.length) throw new ConflictException({ code: 'SESSION_EMPTY', message: 'В приёмке нет принятых единиц' });
      const byProduct = countBy(units.map((u) => u.product_id));
      const warehouseId = await this.stock.mainWarehouseId(tx);
      const summary: Record<string, unknown> = { units: units.length };

      if (session.type === 'PURCHASE') {
        const byLine = countBy(units.map((u) => u.purchase_line_id!).filter(Boolean));
        const lines = await tx.purchase_lines.findMany({ where: { id: { in: [...byLine.keys()] } } });
        const purchaseIds = [...new Set(lines.map((l) => l.purchase_id))].sort();
        for (const id of purchaseIds) await tx.$queryRaw`SELECT id FROM purchases WHERE id = ${id}::uuid FOR UPDATE`;
        for (const l of lines) {
          const qty = byLine.get(l.id)!;
          await tx.purchase_lines.update({ where: { id: l.id }, data: { received_qty: { increment: qty } } });
          await tx.purchase_events.create({
            data: {
              purchase_id: l.purchase_id,
              purchase_line_id: l.id,
              type: 'RECEIVED',
              qty,
              note: 'Приёмка завершена',
              before_json: { received_qty: l.received_qty },
              after_json: { received_qty: l.received_qty + qty },
              created_by: staffId,
            },
          });
        }
        for (const id of purchaseIds) {
          const p = await tx.purchases.findUniqueOrThrow({ where: { id }, include: { lines: true } });
          const status = derivePurchaseStatus(p.lines);
          if (status !== p.status) await tx.purchases.update({ where: { id }, data: { status } });
        }
        for (const [productId, qty] of byProduct) {
          await this.stock.receiveUnits(tx, { warehouseId, productId, qty, referenceType: 'receiving_session', referenceId: session.id, reason: 'Приёмка по закупке', staffId });
        }
        summary.purchases = purchaseIds;
      } else {
        // Opening balance: the stock becomes the number of units in stock; from now on the product is unit-tracked.
        const changes: object[] = [];
        for (const productId of [...byProduct.keys()].sort()) {
          const target = await tx.physical_units.count({ where: { product_id: productId, status: 'IN_STOCK' } });
          const res = await this.stock.setActualQty(tx, { warehouseId, productId, target, referenceType: 'receiving_session', referenceId: session.id, reason: OPENING_REASON, staffId });
          await tx.products.update({ where: { id: productId }, data: { unit_tracking: true } });
          changes.push({ product_id: productId, ...res });
        }
        summary.stock = changes;
      }

      await tx.receiving_sessions.update({ where: { id: session.id }, data: { status: 'COMPLETED', completed_at: new Date(), completion_key: key } });
      await this.audit.log({ staffId, action: 'receiving.completed', entityType: 'receiving_session', entityId: session.id, after: { type: session.type, ...summary } }, tx);
      return { replayed: false };
    }, TX);
  }

  /** «Отменить»: the units become VOIDED (kept, their numbers are never used again); the stock is not changed. */
  async cancel(staffId: string, role: StaffRole, sessionId: string, dto: CancelSessionDto) {
    await this.prisma.$transaction(async (tx) => {
      const session = await this.lockSession(tx, sessionId);
      if (session.type === 'OPENING_BALANCE' && !can(role, 'receiving.opening')) {
        throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE', message: 'Начальный остаток отменяет только администратор' });
      }
      if (session.status !== 'OPEN') throw new ConflictException({ code: 'SESSION_NOT_OPEN', message: 'Эта приёмка уже завершена или отменена' });
      const voided = await moveUnits(tx, { receiving_session_id: session.id }, 'RECEIVED', 'VOIDED', {
        type: 'VOIDED',
        referenceType: 'receiving_session',
        referenceId: session.id,
        note: dto.reason || 'Приёмка отменена',
        staffId,
      });
      for (const lineId of new Set(voided.map((u) => u.purchase_line_id).filter((x): x is string => !!x))) await reassignLineUnitCosts(tx, lineId, staffId);
      await tx.receiving_sessions.update({ where: { id: session.id }, data: { status: 'CANCELLED' } });
      await this.audit.log(
        { staffId, action: 'receiving.cancelled', entityType: 'receiving_session', entityId: session.id, after: { voided: voided.length, reason: dto.reason ?? null } },
        tx,
      );
    }, TX);
  }

  // ---------------------------------------------------------------- internals

  private async lockSession(tx: Tx, id: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM receiving_sessions WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked.length) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Приёмка не найдена' });
    return tx.receiving_sessions.findUniqueOrThrow({ where: { id } });
  }

  /** Lines of the EXPECTED purchases of a source: oldest purchase first, then line position. */
  private sourceLines(db: Tx | PrismaService, src: { ozon_account_id?: string | null; supplier_id?: string | null }) {
    return db.purchase_lines.findMany({
      where: { purchase: { status: 'EXPECTED', ...sourceWhere(src) } },
      include: { purchase: true, product: { select: { id: true, sku: true, name_ru: true } } },
      orderBy: [{ purchase: { purchase_date: 'asc' } }, { purchase: { created_at: 'asc' } }, { position: 'asc' }],
    });
  }

  /** Units accepted in open sessions (RECEIVED) per line: they are not in received_qty yet. */
  private async pendingByLine(db: Tx | PrismaService, lineIds: string[]) {
    const rows = await db.physical_units.groupBy({ by: ['purchase_line_id'], where: { purchase_line_id: { in: lineIds }, status: 'RECEIVED' }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.purchase_line_id!, r._count._all]));
  }
}

function countBy(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

// ---------------------------------------------------------------- controller

const fullFor = (role: StaffRole) => can(role, 'purchases.view_costs');

@ApiTags('staff: receiving')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/receiving')
export class AdminReceivingController {
  constructor(private readonly receiving: AdminReceivingService) {}

  @Get('sources')
  @RequirePermission('receiving.perform')
  sources() {
    return this.receiving.sources();
  }

  @Get('expected')
  @RequirePermission('receiving.perform')
  expected(@CurrentStaff() me: StaffContext, @Query() q: ExpectedQuery) {
    return this.receiving.expected(q, fullFor(me.staff.role));
  }

  @Get('sessions')
  @RequirePermission('receiving.perform')
  list(@Query() q: SessionsQuery) {
    return this.receiving.listSessions(q);
  }

  @Post('sessions')
  @HttpCode(200)
  @RequirePermission('receiving.perform')
  async start(@CurrentStaff() me: StaffContext, @Body() dto: StartSessionDto) {
    return this.receiving.get(await this.receiving.start(me.staff.id, dto), fullFor(me.staff.role));
  }

  @Get('sessions/:id')
  @RequirePermission('receiving.perform')
  get(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.receiving.get(id, fullFor(me.staff.role));
  }

  @Post('sessions/:id/accept')
  @HttpCode(200)
  @RequirePermission('receiving.perform')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Один ключ на одно нажатие «Создать Physical ID»' })
  async accept(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Headers('idempotency-key') key: string | undefined, @Body() dto: AcceptDto) {
    const res = await this.receiving.accept(me.staff.id, id, requireIdempotencyKey(key), dto);
    return { ...(await this.receiving.get(id, fullFor(me.staff.role))), created: res.physical_ids, warnings: res.warnings, replayed: res.replayed };
  }

  @Post('sessions/:id/complete')
  @HttpCode(200)
  @RequirePermission('receiving.perform')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async complete(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Headers('idempotency-key') key: string | undefined) {
    const { replayed } = await this.receiving.complete(me.staff.id, me.staff.role, id, requireIdempotencyKey(key));
    return { ...(await this.receiving.get(id, fullFor(me.staff.role))), replayed };
  }

  @Post('sessions/:id/cancel')
  @HttpCode(200)
  @RequirePermission('receiving.perform')
  async cancel(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CancelSessionDto) {
    await this.receiving.cancel(me.staff.id, me.staff.role, id, dto);
    return this.receiving.get(id, fullFor(me.staff.role));
  }
}
