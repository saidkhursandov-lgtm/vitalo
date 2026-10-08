import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { PhysicalUnitStatus, Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { StockService } from '../inventory/stock.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../staff/audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from '../staff/staff-auth';
import { CORRECTABLE_FROM, CORRECTABLE_TO, moveUnit, onShelf, shiftShelf, UNIT_STATUS_RU, type StockMove } from './unit-lifecycle';

type Tx = Prisma.TransactionClient;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UnitReasonDto {
  @ApiProperty({ example: 'Не нашли на полке при пересчёте' }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

export class ReturnDecisionDto {
  @ApiProperty({ enum: ['ACCEPT', 'WRITE_OFF'] }) @IsIn(['ACCEPT', 'WRITE_OFF']) decision!: 'ACCEPT' | 'WRITE_OFF';
  @ApiProperty() @Transform(trim) @IsString() @MinLength(3) @MaxLength(300) reason!: string;
  @ApiPropertyOptional({ description: 'Для «Вернуть на склад»: срок годности и целостность проверены' }) @IsOptional() @IsBoolean() checked?: boolean;
}

export class CorrectUnitDto {
  @ApiPropertyOptional({ example: '2028-05-15' }) @IsOptional() @IsDateString({ strict: true }) expiry_date?: string;
  @ApiPropertyOptional({ enum: CORRECTABLE_TO }) @IsOptional() @IsIn([...CORRECTABLE_TO]) status?: PhysicalUnitStatus;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Stage 2C actions on one unit (Склад → Единицы): lost (MISSING) and found, write-off (admin), correction (admin),
 * the decision on a returned unit. Every action: the unit row locked, a reason, a unit history event, an audit
 * row, and the shelf stock (inventory.actual_qty) moved when the unit appears on or leaves the shelf.
 */
@Injectable()
export class UnitActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly audit: AuditService,
  ) {}

  /** «Возвраты на проверке»: units in RETURNED with their order. */
  async returns() {
    const units = await this.prisma.physical_units.findMany({
      where: { status: 'RETURNED' },
      orderBy: { seq: 'asc' },
      include: {
        product: { select: { sku: true, name_ru: true } },
        marketplace_units: { where: { released_at: null }, include: { order: { select: { id: true, external_number: true, cancel_reason: true } } } },
      },
    });
    return units.map((u) => ({
      id: u.id,
      physical_id: u.physical_id,
      product: u.product,
      expiry_date: day(u.expiry_date),
      expired: day(u.expiry_date) < day(new Date()),
      order: u.marketplace_units[0]?.order ?? null,
    }));
  }

  /** IN_STOCK -> MISSING (warehouse, admin): the unit leaves the shelf stock. */
  missing(me: StaffContext, id: string, dto: UnitReasonDto) {
    return this.inUnitTx(id, async (tx, u, warehouseId) => {
      this.expect(u, ['IN_STOCK'], 'отметить потерянной');
      await shiftShelf(tx, this.move(warehouseId, u, me, `Потеряна: ${dto.reason}`), -1, 'adjustment');
      await moveUnit(tx, u.id, 'IN_STOCK', 'MISSING', { type: 'MISSING', note: dto.reason, staffId: me.staff.id });
      await this.log(tx, me, 'unit.missing', u, { reason: dto.reason });
    });
  }

  /** MISSING -> IN_STOCK (warehouse, admin): found again, back on the shelf. */
  found(me: StaffContext, id: string, dto: UnitReasonDto) {
    return this.inUnitTx(id, async (tx, u, warehouseId) => {
      this.expect(u, ['MISSING'], 'вернуть как найденную');
      await shiftShelf(tx, this.move(warehouseId, u, me, `Найдена: ${dto.reason}`), 1, 'adjustment');
      await moveUnit(tx, u.id, 'MISSING', 'IN_STOCK', { type: 'FOUND', note: dto.reason, staffId: me.staff.id });
      await this.log(tx, me, 'unit.found', u, { reason: dto.reason });
    });
  }

  /** Admin only: IN_STOCK (shelf stock goes down), RETURNED or MISSING (already off the shelf) -> WRITTEN_OFF. */
  writeOff(me: StaffContext, id: string, dto: UnitReasonDto) {
    return this.inUnitTx(id, async (tx, u, warehouseId) => {
      this.expect(u, ['IN_STOCK', 'RETURNED', 'MISSING'], 'списать');
      if (u.status === 'IN_STOCK') await shiftShelf(tx, this.move(warehouseId, u, me, `Списана: ${dto.reason}`), -1, 'writeoff');
      if (u.status === 'RETURNED') await this.closeReturn(tx, u.id, 'WRITTEN_OFF', dto.reason);
      await moveUnit(tx, u.id, u.status, 'WRITTEN_OFF', { type: 'WRITTEN_OFF', note: dto.reason, staffId: me.staff.id });
      await this.log(tx, me, 'unit.written_off', u, { reason: dto.reason });
    });
  }

  /**
   * Warehouse and admin decide on a returned unit: back on stock (expiry and the jar checked; an expired unit is
   * not taken back) or written off. Either way the unit leaves its order.
   */
  returnDecision(me: StaffContext, id: string, dto: ReturnDecisionDto) {
    return this.inUnitTx(id, async (tx, u, warehouseId) => {
      this.expect(u, ['RETURNED'], 'принять решение по возврату');
      if (dto.decision === 'ACCEPT') {
        if (!dto.checked) throw new BadRequestException({ code: 'CHECK_REQUIRED', message: 'Подтвердите, что срок годности и целостность банки проверены' });
        if (day(u.expiry_date) < day(new Date())) throw new ConflictException({ code: 'EXPIRED', message: 'Срок годности истёк — такую банку нельзя вернуть на склад, только списать' });
        await this.closeReturn(tx, u.id, 'ACCEPTED', dto.reason);
        await shiftShelf(tx, this.move(warehouseId, u, me, `Возврат принят: ${dto.reason}`), 1, 'return_to_stock');
        await moveUnit(tx, u.id, 'RETURNED', 'IN_STOCK', { type: 'RETURN_ACCEPTED', note: dto.reason, staffId: me.staff.id });
        await this.log(tx, me, 'unit.return_accepted', u, { reason: dto.reason });
      } else {
        await this.closeReturn(tx, u.id, 'WRITTEN_OFF', dto.reason);
        await moveUnit(tx, u.id, 'RETURNED', 'WRITTEN_OFF', { type: 'RETURN_WRITTEN_OFF', note: dto.reason, staffId: me.staff.id });
        await this.log(tx, me, 'unit.return_written_off', u, { reason: dto.reason });
      }
    });
  }

  /**
   * Admin only, «при явной ошибке»: the expiry date and/or the status (between На складе / Потеряна / Списана, and
   * from «Возврат на проверке» to «Потеряна»). Units of an order move only with the order. Never deleted.
   */
  correct(me: StaffContext, id: string, dto: CorrectUnitDto) {
    if (!dto.expiry_date && !dto.status) throw new BadRequestException({ code: 'NOTHING_TO_CORRECT', message: 'Укажите новый срок годности или статус' });
    return this.inUnitTx(id, async (tx, u, warehouseId) => {
      const before = { status: u.status, expiry_date: day(u.expiry_date) };
      if (u.status === 'VOIDED') throw new ConflictException({ code: 'UNIT_VOIDED', message: 'Отменённую единицу не корректируют' });
      if (dto.expiry_date && dto.expiry_date !== before.expiry_date) {
        await tx.physical_units.update({ where: { id: u.id }, data: { expiry_date: new Date(`${dto.expiry_date}T00:00:00Z`) } });
        await tx.physical_unit_events.create({
          data: { physical_unit_id: u.id, type: 'EXPIRY_CORRECTED', note: `Срок ${ruDate(before.expiry_date)} → ${ruDate(dto.expiry_date)}: ${dto.reason}`, created_by: me.staff.id },
        });
      }
      if (dto.status && dto.status !== u.status) {
        if (!CORRECTABLE_FROM.includes(u.status) || (u.status === 'RETURNED' && dto.status !== 'MISSING')) {
          throw new ConflictException({
            code: 'UNIT_TRANSITION',
            message: `Из статуса «${UNIT_STATUS_RU[u.status]}» корректировкой не переводят${u.status === 'RETURNED' ? ' (для возврата — «Решение по возврату»)' : ' — банка в заказе, меняйте статус заказа'}`,
          });
        }
        const delta = Number(onShelf(dto.status)) - Number(onShelf(u.status));
        if (delta) await shiftShelf(tx, this.move(warehouseId, u, me, `Корректировка статуса: ${dto.reason}`), delta as 1 | -1, 'adjustment');
        if (u.status === 'RETURNED') await this.closeReturn(tx, u.id, null, `Корректировка: ${dto.reason}`);
        await moveUnit(tx, u.id, u.status, dto.status, { type: 'STATUS_CORRECTED', note: dto.reason, staffId: me.staff.id });
      }
      await this.log(tx, me, 'unit.corrected', u, { reason: dto.reason, before, after: { status: dto.status ?? u.status, expiry_date: dto.expiry_date ?? before.expiry_date } });
    });
  }

  // ---------------------------------------------------------------- helpers

  private async inUnitTx(id: string, fn: (tx: Tx, unit: LockedUnit, warehouseId: string) => Promise<void>) {
    await this.prisma.$transaction(async (tx) => {
      const [u] = await tx.$queryRaw<LockedUnit[]>`
        SELECT id, physical_id, product_id, status, expiry_date FROM physical_units WHERE id = ${id}::uuid FOR UPDATE`;
      if (!u) throw new NotFoundException({ code: 'UNIT_NOT_FOUND', message: 'Единица не найдена' });
      await fn(tx, u, await this.stock.mainWarehouseId(tx));
    });
    const u = await this.prisma.physical_units.findUniqueOrThrow({ where: { id }, select: { id: true, physical_id: true, status: true, expiry_date: true } });
    return { ...u, expiry_date: day(u.expiry_date) };
  }

  private expect(u: LockedUnit, allowed: PhysicalUnitStatus[], what: string) {
    if (!allowed.includes(u.status)) {
      throw new ConflictException({ code: 'UNIT_TRANSITION', message: `${u.physical_id} в статусе «${UNIT_STATUS_RU[u.status]}»: ${what} нельзя` });
    }
  }

  private move(warehouseId: string, u: LockedUnit, me: StaffContext, reason: string): StockMove {
    return { warehouseId, productId: u.product_id, referenceType: 'physical_unit', referenceId: u.id, reason: `${u.physical_id} ${reason}`, staffId: me.staff.id };
  }

  /** A returned unit leaves its order (the assignment is released, the decision kept). */
  private async closeReturn(tx: Tx, unitId: string, decision: 'ACCEPTED' | 'WRITTEN_OFF' | null, reason: string) {
    await tx.marketplace_order_units.updateMany({
      where: { physical_unit_id: unitId, released_at: null },
      data: { released_at: new Date(), release_reason: reason, return_decision: decision },
    });
  }

  private log(tx: Tx, me: StaffContext, action: string, u: LockedUnit, after: object) {
    return this.audit.log({ staffId: me.staff.id, action, entityType: 'physical_unit', entityId: u.id, before: { physical_id: u.physical_id, status: u.status }, after }, tx);
  }
}

interface LockedUnit {
  id: string;
  physical_id: string;
  product_id: string;
  status: PhysicalUnitStatus;
  expiry_date: Date;
}

const ruDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

@ApiTags('staff: units')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/units')
export class UnitActionsController {
  constructor(private readonly actions: UnitActionsService) {}

  @Get('returns/pending')
  @RequirePermission('units.view')
  returns() {
    return this.actions.returns();
  }

  @Post(':id/missing')
  @HttpCode(200)
  @RequirePermission('units.missing')
  missing(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UnitReasonDto) {
    return this.actions.missing(me, id, dto);
  }

  @Post(':id/found')
  @HttpCode(200)
  @RequirePermission('units.missing')
  found(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UnitReasonDto) {
    return this.actions.found(me, id, dto);
  }

  @Post(':id/write-off')
  @HttpCode(200)
  @RequirePermission('units.writeoff')
  writeOff(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UnitReasonDto) {
    return this.actions.writeOff(me, id, dto);
  }

  @Post(':id/return-decision')
  @HttpCode(200)
  @RequirePermission('units.return_decision')
  returnDecision(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ReturnDecisionDto) {
    return this.actions.returnDecision(me, id, dto);
  }

  @Post(':id/correct')
  @HttpCode(200)
  @RequirePermission('units.correct')
  correct(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CorrectUnitDto) {
    return this.actions.correct(me, id, dto);
  }
}
