import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { Prisma, StaffRole, StaffStatus, TariffStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';
import { PageQuery } from '../catalog/catalog.dto';
import { DeliveryService } from '../delivery/delivery.service';
import { PrismaService } from '../prisma/prisma.service';
import { BankTransferDetails, SETTING_KEYS } from '../settings/settings.service';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffAuthService, StaffContext, StaffGuard } from './staff-auth';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// ---------------- DTOs ----------------

export class BankTransferDto implements BankTransferDetails {
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) recipient!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) bank_name!: string;
  @ApiProperty({ example: '20208000000000000001' }) @Transform(trim) @Matches(/^\d{20}$/, { message: 'account: 20 digits' }) account!: string;
  @ApiProperty({ example: '00014' }) @Transform(trim) @Matches(/^\d{5}$/, { message: 'mfo: 5 digits' }) mfo!: string;
  @ApiProperty({ example: '123456789' }) @Transform(trim) @Matches(/^\d{9}$/, { message: 'inn: 9 digits' }) inn!: string;

  @ApiProperty({ example: 'Оплата заказа {order_number}' })
  @Transform(trim)
  @IsString()
  @Matches(/\{order_number\}/, { message: 'purpose_template must contain {order_number}' })
  @MaxLength(200)
  purpose_template!: string;
}

export class TariffDto {
  @ApiProperty() @IsUUID() region_id!: string;
  @ApiPropertyOptional({ nullable: true, description: 'Пусто — тариф по умолчанию для всего региона' }) @IsOptional() @IsUUID() city_id?: string | null;
  @ApiProperty() @IsInt() @Min(0) tariff_uzs!: number;
  @ApiProperty() @IsInt() @Min(0) free_shipping_threshold_uzs!: number;
  @ApiPropertyOptional({ enum: TariffStatus }) @IsOptional() @IsEnum(TariffStatus) status?: TariffStatus;
}

export class TariffPatch extends PartialType(TariffDto) {}

export class StaffUserDto {
  @ApiProperty({ example: '123456789', description: 'Telegram ID сотрудника' })
  @Transform(({ value }) => String(value).trim())
  @Matches(/^\d{5,15}$/, { message: 'telegram_user_id: digits only' })
  telegram_user_id!: string;

  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) name!: string;
  @ApiProperty({ enum: StaffRole }) @IsEnum(StaffRole) role!: StaffRole;
}

export class StaffUserPatch {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @ApiPropertyOptional({ enum: StaffRole }) @IsOptional() @IsEnum(StaffRole) role?: StaffRole;
  @ApiPropertyOptional({ enum: StaffStatus }) @IsOptional() @IsEnum(StaffStatus) status?: StaffStatus;
}

export class AuditQuery extends PageQuery {
  @ApiPropertyOptional({ example: 'order' }) @IsOptional() @IsString() @MaxLength(50) entity_type?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() entity_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() staff_id?: string;
  @ApiPropertyOptional({ example: 'order.' , description: 'Начало названия действия' }) @IsOptional() @IsString() @MaxLength(50) action?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() date_from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() date_to?: string;
}

// ---------------- services ----------------

@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: DeliveryService,
    private readonly audit: AuditService,
    private readonly staffAuth: StaffAuthService,
  ) {}

  async bankTransfer() {
    const row = await this.prisma.settings.findUnique({ where: { key: SETTING_KEYS.bankTransferDetails } });
    return (row?.value as BankTransferDetails | undefined) ?? null;
  }

  async setBankTransfer(staffId: string, dto: BankTransferDto) {
    const value = { ...dto } as unknown as Prisma.InputJsonValue;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.settings.findUnique({ where: { key: SETTING_KEYS.bankTransferDetails } });
      await tx.settings.upsert({ where: { key: SETTING_KEYS.bankTransferDetails }, create: { key: SETTING_KEYS.bankTransferDetails, value }, update: { value } });
      await this.audit.log({ staffId, action: 'settings.bank_transfer_updated', entityType: 'settings', before: before?.value, after: value }, tx);
    });
    return this.bankTransfer();
  }

  async tariffs() {
    const rows = await this.prisma.delivery_tariffs.findMany({ include: { region: true, city: true }, orderBy: [{ region: { name_ru: 'asc' } }] });
    return rows.map((t) => ({
      id: t.id,
      region: { id: t.region.id, name_ru: t.region.name_ru },
      city: t.city ? { id: t.city.id, name_ru: t.city.name_ru } : null,
      tariff_uzs: Number(t.tariff_uzs),
      free_shipping_threshold_uzs: Number(t.free_shipping_threshold_uzs),
      status: t.status,
    }));
  }

  async createTariff(staffId: string, dto: TariffDto) {
    await this.prisma.$transaction(async (tx) => {
      await this.validateTariff(tx, dto.region_id, dto.city_id ?? null, dto.status ?? 'active');
      const t = await tx.delivery_tariffs.create({ data: this.tariffData(dto) as Prisma.delivery_tariffsUncheckedCreateInput });
      await this.audit.log({ staffId, action: 'tariff.created', entityType: 'delivery_tariff', entityId: t.id, after: t }, tx);
    });
    return this.tariffs();
  }

  async updateTariff(staffId: string, id: string, dto: TariffPatch) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.delivery_tariffs.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Tariff not found');
      const regionId = dto.region_id ?? before.region_id;
      const cityId = dto.city_id === undefined ? before.city_id : dto.city_id;
      await this.validateTariff(tx, regionId, cityId, dto.status ?? before.status, id);
      const after = await tx.delivery_tariffs.update({ where: { id }, data: this.tariffData(dto) });
      await this.audit.log({ staffId, action: 'tariff.updated', entityType: 'delivery_tariff', entityId: id, before, after }, tx);
    });
    return this.tariffs();
  }

  async staffList() {
    const rows = await this.prisma.staff_users.findMany({
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { sessions: { where: { revoked_at: null, expires_at: { gt: new Date() } } } } } },
    });
    return rows.map((s) => ({
      id: s.id,
      telegram_user_id: Number(s.telegram_user_id),
      name: s.name,
      role: s.role,
      status: s.status,
      active_sessions: s._count.sessions,
      created_at: s.created_at,
    }));
  }

  async createStaff(staffId: string, dto: StaffUserDto) {
    try {
      const s = await this.prisma.staff_users.create({ data: { telegram_user_id: BigInt(dto.telegram_user_id), name: dto.name, role: dto.role } });
      await this.audit.log({ staffId, action: 'staff.created', entityType: 'staff_user', entityId: s.id, after: s });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: 'STAFF_EXISTS', message: 'An employee with this Telegram ID already exists' });
      }
      throw e;
    }
    return this.staffList();
  }

  /** An admin cannot demote or block themselves (otherwise nobody may be left to manage staff). */
  async updateStaff(me: StaffContext, id: string, dto: StaffUserPatch) {
    if (id === me.staff.id && ((dto.role && dto.role !== me.staff.role) || dto.status === 'blocked')) {
      throw new ConflictException({ code: 'CANNOT_CHANGE_SELF', message: 'You cannot change your own role or block yourself' });
    }
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.staff_users.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Employee not found');
      const after = await tx.staff_users.update({ where: { id }, data: dto });
      // Blocking or a role change signs the employee out, so new rights apply at once.
      if (dto.status === 'blocked' || (dto.role && dto.role !== before.role)) {
        await tx.staff_sessions.updateMany({ where: { staff_user_id: id, revoked_at: null }, data: { revoked_at: new Date() } });
      }
      await this.audit.log({ staffId: me.staff.id, action: 'staff.updated', entityType: 'staff_user', entityId: id, before, after }, tx);
    });
    return this.staffList();
  }

  async revokeSessions(staffId: string, id: string) {
    const exists = await this.prisma.staff_users.count({ where: { id } });
    if (!exists) throw new NotFoundException('Employee not found');
    const revoked = await this.staffAuth.revokeAll(id);
    await this.audit.log({ staffId, action: 'staff.sessions_revoked', entityType: 'staff_user', entityId: id, after: { revoked } });
    return { revoked };
  }

  async auditLog(q: AuditQuery) {
    const where: Prisma.audit_logsWhereInput = {
      ...(q.entity_type && { entity_type: q.entity_type }),
      ...(q.entity_id && { entity_id: q.entity_id }),
      ...(q.staff_id && { staff_user_id: q.staff_id }),
      ...(q.action && { action: { startsWith: q.action } }),
      ...((q.date_from || q.date_to) && {
        created_at: {
          ...(q.date_from && { gte: new Date(`${q.date_from}T00:00:00+05:00`) }),
          ...(q.date_to && { lt: new Date(new Date(`${q.date_to}T00:00:00+05:00`).getTime() + 86_400_000) }),
        },
      }),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.audit_logs.count({ where }),
      this.prisma.audit_logs.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (q.page - 1) * 50,
        take: 50,
        include: { staff: { select: { name: true, role: true } } },
      }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        staff: r.staff ? { id: r.staff_user_id, name: r.staff.name, role: r.staff.role } : null,
        action: r.action,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        before: r.before_json,
        after: r.after_json,
      })),
      page: q.page,
      page_size: 50,
      total,
      total_pages: Math.ceil(total / 50),
    };
  }

  private tariffData(dto: TariffPatch): Prisma.delivery_tariffsUncheckedUpdateInput {
    return {
      ...(dto.region_id && { region_id: dto.region_id }),
      ...(dto.city_id !== undefined && { city_id: dto.city_id }),
      ...(dto.tariff_uzs !== undefined && { tariff_uzs: BigInt(dto.tariff_uzs) }),
      ...(dto.free_shipping_threshold_uzs !== undefined && { free_shipping_threshold_uzs: BigInt(dto.free_shipping_threshold_uzs) }),
      ...(dto.status && { status: dto.status }),
    };
  }

  /** City must be in the region; only one active tariff per region (default) or per city. */
  private async validateTariff(tx: Prisma.TransactionClient, regionId: string, cityId: string | null, status: TariffStatus, exceptId?: string) {
    if (cityId) await this.delivery.assertCityInRegion(regionId, cityId, tx);
    else if (!(await tx.regions.count({ where: { id: regionId } }))) {
      throw new ConflictException({ code: 'INVALID_ADDRESS', message: 'Unknown region' });
    }
    if (status !== 'active') return;
    const clash = await tx.delivery_tariffs.count({
      where: { region_id: regionId, city_id: cityId, status: 'active', ...(exceptId && { id: { not: exceptId } }) },
    });
    if (clash) throw new ConflictException({ code: 'TARIFF_EXISTS', message: 'An active tariff for this region/city already exists' });
  }
}

// ---------------- controllers ----------------

@ApiTags('staff: settings')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@RequirePermission('settings.manage')
@Controller('staff/settings')
export class AdminSettingsController {
  constructor(private readonly settings: AdminSettingsService) {}

  @Get('bank-transfer')
  bankTransfer() {
    return this.settings.bankTransfer();
  }

  @Put('bank-transfer')
  setBankTransfer(@CurrentStaff() me: StaffContext, @Body() dto: BankTransferDto) {
    return this.settings.setBankTransfer(me.staff.id, dto);
  }

  @Get('tariffs')
  tariffs() {
    return this.settings.tariffs();
  }

  @Post('tariffs')
  createTariff(@CurrentStaff() me: StaffContext, @Body() dto: TariffDto) {
    return this.settings.createTariff(me.staff.id, dto);
  }

  @Patch('tariffs/:id')
  updateTariff(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: TariffPatch) {
    return this.settings.updateTariff(me.staff.id, id, dto);
  }
}

@ApiTags('staff: employees')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@RequirePermission('staff.manage')
@Controller('staff/users')
export class StaffUsersController {
  constructor(private readonly settings: AdminSettingsService) {}

  @Get()
  list() {
    return this.settings.staffList();
  }

  @Post()
  create(@CurrentStaff() me: StaffContext, @Body() dto: StaffUserDto) {
    return this.settings.createStaff(me.staff.id, dto);
  }

  @Patch(':id')
  update(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: StaffUserPatch) {
    return this.settings.updateStaff(me, id, dto);
  }

  @Post(':id/revoke-sessions')
  @HttpCode(200)
  revoke(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.settings.revokeSessions(me.staff.id, id);
  }
}

@ApiTags('staff: audit')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/audit')
export class AuditController {
  constructor(private readonly settings: AdminSettingsService) {}

  @Get()
  @RequirePermission('audit.view')
  list(@Query() q: AuditQuery) {
    return this.settings.auditLog(q);
  }
}
