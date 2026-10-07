import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { PhysicalUnitStatus, Prisma, StaffRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQuery } from '../catalog/catalog.dto';
import { PrismaService } from '../prisma/prisma.service';
import { can } from '../staff/permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from '../staff/staff-auth';
import { normalizePhysicalId } from './physical-id';
import { RECONCILE_HINT, reconcileUnits } from './reconcile';
import { labelView, unitInclude, unitView } from './units';

const PAGE_SIZE = 50;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UnitsQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'Physical ID (V-000184, 184 …) или SKU' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional({ enum: PhysicalUnitStatus }) @IsOptional() @IsEnum(PhysicalUnitStatus) status?: PhysicalUnitStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() product_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() session_id?: string;
  @ApiPropertyOptional({ description: 'Только для администратора' }) @IsOptional() @IsUUID() purchase_id?: string;
}

export class FindUnitQuery {
  @ApiProperty({ example: '184' }) @Transform(trim) @IsString() @MaxLength(40) code!: string;
}

export class PrintLabelsDto {
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsUUID('all', { each: true }) unit_ids?: string[];
  @ApiPropertyOptional({ description: 'Все единицы приёмки (кроме отменённых)' }) @IsOptional() @IsUUID() session_id?: string;
}

/** Stage 2B «Единицы»: list, lookup by a typed / scanned Physical ID, card with history, label printing. */
@Injectable()
export class AdminUnitsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: UnitsQuery, full: boolean) {
    const and: Prisma.physical_unitsWhereInput[] = [];
    if (q.status) and.push({ status: q.status });
    if (q.product_id) and.push({ product_id: q.product_id });
    if (q.session_id) and.push({ receiving_session_id: q.session_id });
    if (q.purchase_id && full) and.push({ purchase_id: q.purchase_id });
    if (q.q) {
      const id = normalizePhysicalId(q.q);
      and.push({ OR: [...(id ? [{ physical_id: id }] : []), { product: { sku: { contains: q.q, mode: 'insensitive' } } }] });
    }
    const where: Prisma.physical_unitsWhereInput = { AND: and };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.physical_units.count({ where }),
      this.prisma.physical_units.findMany({ where, orderBy: { seq: 'desc' }, skip: (q.page - 1) * PAGE_SIZE, take: PAGE_SIZE, include: unitInclude }),
    ]);
    return { items: rows.map((u) => unitView(u, full)), page: q.page, page_size: PAGE_SIZE, total, total_pages: Math.ceil(total / PAGE_SIZE) };
  }

  /** Enter / scanner: «V-000184», «v-000184», «000184», «184» -> the unit card. */
  async find(code: string, full: boolean) {
    const physicalId = normalizePhysicalId(code);
    if (!physicalId) throw new BadRequestException({ code: 'BAD_PHYSICAL_ID', message: 'Это не Physical ID: введите, например, V-000184 или 184' });
    const u = await this.prisma.physical_units.findUnique({ where: { physical_id: physicalId }, select: { id: true } });
    if (!u) throw new NotFoundException({ code: 'UNIT_NOT_FOUND', message: `Единица ${physicalId} не найдена` });
    return this.get(u.id, full);
  }

  async get(id: string, full: boolean) {
    const u = await this.prisma.physical_units.findUnique({ where: { id }, include: unitInclude });
    if (!u) throw new NotFoundException({ code: 'UNIT_NOT_FOUND', message: 'Единица не найдена' });
    const events = await this.prisma.physical_unit_events.findMany({
      where: { physical_unit_id: id, ...(!full && { type: { not: 'COST_CHANGED' } }) }, // cost history: admin only
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      include: { staff: { select: { name: true } } },
    });
    return {
      ...unitView(u, full),
      label: labelView(u),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        from_status: e.from_status,
        to_status: e.to_status,
        note: e.note,
        staff_name: e.staff?.name ?? null,
        created_at: e.created_at,
        // a receiving session is fine for everybody; a purchase reference only with costs
        reference: e.reference_type && (full || e.reference_type === 'receiving_session') ? { type: e.reference_type, id: e.reference_id } : null,
      })),
    };
  }

  /**
   * Opening the print page: label data of the units (one, a session or a selection) + LABEL_PRINTED and
   * label_print_count + 1 for each. Printing again is allowed. Cancelled (VOIDED) units are not printed.
   */
  async printLabels(staffId: string, dto: PrintLabelsDto) {
    if (!dto.unit_ids?.length && !dto.session_id) throw new BadRequestException({ code: 'NOTHING_TO_PRINT', message: 'Выберите единицы или приёмку' });
    return this.prisma.$transaction(async (tx) => {
      const units = await tx.physical_units.findMany({
        where: dto.session_id ? { receiving_session_id: dto.session_id, status: { not: 'VOIDED' } } : { id: { in: dto.unit_ids } },
        orderBy: { seq: 'asc' },
        include: unitInclude,
      });
      if (!units.length) throw new NotFoundException({ code: 'UNIT_NOT_FOUND', message: 'Единицы не найдены' });
      const voided = units.filter((u) => u.status === 'VOIDED');
      if (voided.length) {
        throw new ConflictException({ code: 'UNIT_VOIDED', message: `Отменённые единицы не печатаются: ${voided.map((u) => u.physical_id).join(', ')}` });
      }
      const now = new Date();
      await tx.physical_units.updateMany({ where: { id: { in: units.map((u) => u.id) } }, data: { label_print_count: { increment: 1 }, last_printed_at: now } });
      await tx.physical_unit_events.createMany({
        data: units.map((u) => ({ physical_unit_id: u.id, type: 'LABEL_PRINTED', note: `Печать этикетки №${u.label_print_count + 1}`, created_by: staffId })),
      });
      const missing = [...new Set(units.filter((u) => !u.product.label_composition_ru || !u.product.label_composition_uz).map((u) => u.product.sku))];
      return {
        labels: units.map(labelView),
        warnings: missing.map((sku) => `${sku}: не заполнен короткий состав для этикетки — этикетка напечатается без него`),
      };
    });
  }

  async reconcile() {
    return { hint: RECONCILE_HINT, items: await reconcileUnits(this.prisma) };
  }
}

const fullFor = (role: StaffRole) => can(role, 'purchases.view_costs');

@ApiTags('staff: units')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/units')
export class AdminUnitsController {
  constructor(private readonly units: AdminUnitsService) {}

  @Get()
  @RequirePermission('units.view')
  list(@CurrentStaff() me: StaffContext, @Query() q: UnitsQuery) {
    return this.units.list(q, fullFor(me.staff.role));
  }

  @Get('find')
  @RequirePermission('units.view')
  find(@CurrentStaff() me: StaffContext, @Query() q: FindUnitQuery) {
    return this.units.find(q.code, fullFor(me.staff.role));
  }

  @Get('reconcile')
  @RequirePermission('units.view')
  reconcile() {
    return this.units.reconcile();
  }

  @Post('labels')
  @HttpCode(200)
  @RequirePermission('units.view', 'receiving.perform')
  labels(@CurrentStaff() me: StaffContext, @Body() dto: PrintLabelsDto) {
    return this.units.printLabels(me.staff.id, dto);
  }

  @Get(':id')
  @RequirePermission('units.view')
  get(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.units.get(id, fullFor(me.staff.role));
  }
}
