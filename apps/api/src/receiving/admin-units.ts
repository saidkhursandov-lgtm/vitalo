import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { PhysicalUnitStatus, Prisma, StaffRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQuery } from '../catalog/catalog.dto';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { can, type Permission } from '../staff/permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from '../staff/staff-auth';
import { normalizePhysicalId } from './physical-id';
import { PrintScope, printTicketKey, PrintTicketError, signPrintTicket, TICKET_MAX_UNITS, TICKET_TTL_SECONDS, verifyPrintTicket } from './print-ticket';
import { AuditService } from '../staff/audit.service';
import { RECONCILE_HINT, reconcileUnits } from './reconcile';
import { canStartTracking, notTrackedReason, trackingStates } from './unit-tracking';
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

export class PrintTicketDto {
  @ApiProperty({ description: 'Билет печати из POST /staff/units/labels/ticket' }) @IsString() @IsNotEmpty() @MaxLength(4000) ticket!: string;
}

/** Who may print labels (also checked again when a print ticket is used). */
const PRINT_PERMISSIONS: Permission[] = ['units.view', 'receiving.perform'];

/** Stage 2B «Единицы»: list, lookup by a typed / scanned Physical ID, card with history, label printing. */
@Injectable()
export class AdminUnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

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
        // a receiving session and a Yandex order are fine for everybody; a purchase reference only with costs
        reference: e.reference_type && (full || e.reference_type === 'receiving_session' || e.reference_type === 'marketplace_order' || e.reference_type === 'order') ? { type: e.reference_type, id: e.reference_id } : null,
      })),
    };
  }

  /**
   * Opening the print page: label data of the units (one, a session or a selection) + LABEL_PRINTED and
   * label_print_count + 1 for each. Printing again is allowed. Cancelled (VOIDED) units are not printed.
   */
  async printLabels(staffId: string, dto: PrintLabelsDto) {
    if (!dto.unit_ids?.length && !dto.session_id) throw new BadRequestException({ code: 'NOTHING_TO_PRINT', message: 'Выберите единицы или приёмку' });
    const labels = await this.prisma.$transaction(async (tx) => {
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
      return units.map(labelView);
    });
    // The 58×40 label has no short composition, so a missing one is no warning any more.
    return { labels, label_size: await this.settings.getOrDefault('label_size'), warnings: [] as string[] };
  }

  /** Paper size of the label for the test print (the setting itself is edited in Настройки → Печать). */
  labelSize() {
    return this.settings.getOrDefault('label_size');
  }

  private ticketKey() {
    const secret = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!secret) throw new InternalServerErrorException('TELEGRAM_BOT_TOKEN is not configured');
    return printTicketKey(secret);
  }

  /**
   * «Напечатать этикетки» in the admin panel: a short-lived ticket for the print page, so that it opens in a normal
   * browser too. Only the labels of this receiving / these units, only while the employee's session is valid.
   */
  issueTicket(me: StaffContext, dto: PrintLabelsDto) {
    const scope = scopeOf(dto);
    if (scope.unit_ids && scope.unit_ids.length > TICKET_MAX_UNITS) {
      throw new BadRequestException({ code: 'TOO_MANY_UNITS', message: `Не больше ${TICKET_MAX_UNITS} единиц: всю приёмку печатайте по приёмке` });
    }
    const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
    return { ticket: signPrintTicket(this.ticketKey(), { v: 1, ss: me.sessionId, exp, ...scope }), expires_at: new Date(exp * 1000).toISOString() };
  }

  /** The print page with a ticket: the same as POST /staff/units/labels, on behalf of the employee who asked for it. */
  async printByTicket(ticket: string) {
    let p;
    try {
      p = verifyPrintTicket(this.ticketKey(), ticket);
    } catch (e) {
      if (!(e instanceof PrintTicketError)) throw e;
      throw new UnauthorizedException({
        code: e.message === 'expired' ? 'PRINT_TICKET_EXPIRED' : 'PRINT_TICKET_INVALID',
        message: 'Ссылка на печать устарела или неверна',
      });
    }
    // Logout, block or an expired staff session end the ticket at once.
    const session = await this.prisma.staff_sessions.findUnique({ where: { id: p.ss }, include: { staff_user: true } });
    if (!session || session.revoked_at || session.expires_at <= new Date() || session.staff_user.status !== 'active') {
      throw new UnauthorizedException({ code: 'PRINT_TICKET_INVALID', message: 'Сессия сотрудника закончилась' });
    }
    if (!PRINT_PERMISSIONS.some((perm) => can(session.staff_user.role, perm))) {
      throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE', message: `Role ${session.staff_user.role} cannot do this` });
    }
    return this.printLabels(session.staff_user.id, scopeOf(p));
  }

  async reconcile() {
    return { hint: RECONCILE_HINT, items: await reconcileUnits(this.prisma) };
  }

  /**
   * S2B-10: «Включить учёт по банкам» in «Сверка» for a product whose units came by a purchase before S2B-10 (OZN-A019).
   * The same check as at the end of a receiving: stock = units on the shelf, no open opening balance. Replaces the
   * manual SQL of 25.10.2026. Only the flag changes; units, stock and reserves are not touched.
   */
  async startTracking(staffId: string, productId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
      const [st] = await trackingStates(tx, [productId]);
      if (!st) throw new NotFoundException({ code: 'UNKNOWN_PRODUCT', message: 'Товар не найден' });
      if (st.unit_tracking) return { sku: st.sku, unit_tracking: true, changed: false };
      if (!canStartTracking(st)) throw new ConflictException({ code: 'CANNOT_START_TRACKING', message: notTrackedReason(st) });
      await tx.products.update({ where: { id: productId }, data: { unit_tracking: true } });
      await this.audit.log(
        { staffId, action: 'product.unit_tracking_fix', entityType: 'product', entityId: productId, before: { unit_tracking: false }, after: { unit_tracking: true, actual_qty: st.actual, units_on_shelf: st.on_shelf } },
        tx,
      );
      return { sku: st.sku, unit_tracking: true, changed: true };
    });
  }
}

const fullFor = (role: StaffRole) => can(role, 'purchases.view_costs');

/** Exactly one scope: a receiving session or a list of units. */
function scopeOf(dto: PrintScope): PrintScope {
  if (dto.session_id) return { session_id: dto.session_id };
  if (dto.unit_ids?.length) return { unit_ids: [...new Set(dto.unit_ids)] };
  throw new BadRequestException({ code: 'NOTHING_TO_PRINT', message: 'Выберите единицы или приёмку' });
}

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

  /** S2B-10: switch a product to unit tracking when its stock equals its units — admin only. */
  @Post('start-tracking/:productId')
  @HttpCode(200)
  @RequirePermission('units.start_tracking')
  startTracking(@CurrentStaff() me: StaffContext, @Param('productId', new ParseUUIDPipe()) productId: string) {
    return this.units.startTracking(me.staff.id, productId);
  }

  @Post('labels')
  @HttpCode(200)
  @RequirePermission(...PRINT_PERMISSIONS)
  labels(@CurrentStaff() me: StaffContext, @Body() dto: PrintLabelsDto) {
    return this.units.printLabels(me.staff.id, dto);
  }

  @Get('labels/size')
  @RequirePermission(...PRINT_PERMISSIONS)
  labelSize() {
    return this.units.labelSize();
  }

  @Post('labels/ticket')
  @HttpCode(200)
  @RequirePermission(...PRINT_PERMISSIONS)
  ticket(@CurrentStaff() me: StaffContext, @Body() dto: PrintLabelsDto) {
    return this.units.issueTicket(me, dto);
  }

  @Get(':id')
  @RequirePermission('units.view')
  get(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.units.get(id, fullFor(me.staff.role));
  }
}

/**
 * The label page opened in a normal browser: no staff token, only the print ticket (see print-ticket.ts).
 * It can do exactly one thing — print the labels the ticket names — and nothing else.
 */
@ApiTags('staff: units')
@Controller('print/labels')
export class PrintLabelsController {
  constructor(private readonly units: AdminUnitsService) {}

  @Post()
  @HttpCode(200)
  print(@Body() dto: PrintTicketDto) {
    return this.units.printByTicket(dto.ticket);
  }
}
