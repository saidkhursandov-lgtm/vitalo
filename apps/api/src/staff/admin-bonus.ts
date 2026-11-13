import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { randomUUID } from 'crypto';
import { BonusService } from '../bonus/bonus.service';
import { BonusSettings, normalizeBonusSettings } from '../bonus/bonus-rules';
import { tashkentDateString } from '../common/tashkent';
import { PrismaService } from '../prisma/prisma.service';
import { SETTING_KEYS } from '../settings/settings.service';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** «Настройки → VITALO Bonus» (D-71). The limits are the ones of normalizeBonusSettings. */
export class BonusSettingsDto implements BonusSettings {
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiProperty({ minimum: 0, maximum: 10 }) @IsInt() @Min(0) @Max(10) cashback_pct!: number;
  @ApiProperty({ minimum: 0, maximum: 50 }) @IsInt() @Min(0) @Max(50) max_spend_pct!: number;
  @ApiProperty({ minimum: 30, maximum: 730 }) @IsInt() @Min(30) @Max(730) lifetime_days!: number;
  @ApiProperty({ minimum: 1, maximum: 30 }) @IsInt() @Min(1) @Max(30) remind_days!: number;
  @ApiProperty({ minimum: 0, maximum: 100000 }) @IsInt() @Min(0) @Max(100_000) review_uzs!: number;
  @ApiProperty({ minimum: 0, maximum: 100000 }) @IsInt() @Min(0) @Max(100_000) review_photo_uzs!: number;
}

/** «+ Начислить» (amount > 0) / «− Списать» (amount < 0) on the customer card; the reason is required. */
export class ManualBonusDto {
  @ApiProperty({ example: 10000, description: 'Плюс — начислить, минус — списать' }) @IsInt() @Min(-10_000_000) @Max(10_000_000) amount!: number;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(300) reason!: string;
}

export class BonusStatsQuery {
  @ApiPropertyOptional({ example: '2026-11' }) @IsOptional() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month?: string;
}

/**
 * 3.10-А (D-71): VITALO Bonus in the admin panel — settings, a customer's balance by hand, the month numbers.
 * Admin only («bonus.manage»): bonuses are money owed to customers. Every change is in the audit log.
 */
@ApiTags('staff: bonus')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/bonus')
export class AdminBonusController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bonus: BonusService,
    private readonly audit: AuditService,
  ) {}

  @Get('settings')
  @RequirePermission('bonus.manage')
  settings() {
    return this.bonus.settings();
  }

  @Put('settings')
  @RequirePermission('bonus.manage')
  async save(@CurrentStaff() me: StaffContext, @Body() dto: BonusSettingsDto) {
    const value = normalizeBonusSettings({ ...dto });
    await this.prisma.$transaction(async (tx) => {
      const before = await this.bonus.settings();
      await tx.settings.upsert({ where: { key: SETTING_KEYS.bonus }, create: { key: SETTING_KEYS.bonus, value: { ...value } }, update: { value: { ...value } } });
      await this.audit.log({ staffId: me.staff.id, action: 'settings.bonus_updated', entityType: 'setting', entityId: null, before, after: value }, tx);
    });
    return this.bonus.settings();
  }

  /** Accrued / spent / given back / taken / burnt in a month (Tashkent) and the balance owed to customers now. */
  @Get('stats')
  @RequirePermission('bonus.manage')
  stats(@Query() q: BonusStatsQuery) {
    return this.bonus.monthStats(q.month ?? tashkentDateString(new Date()).slice(0, 7));
  }

  @Post('customers/:id')
  @RequirePermission('bonus.manage')
  async manual(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ManualBonusDto) {
    if (dto.amount === 0) throw new UnprocessableEntityException({ code: 'BONUS_ZERO', message: 'Укажите сумму' });
    const r = await this.prisma.$transaction(async (tx) => {
      if (!(await tx.users.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Customer not found');
      const before = await this.bonus.balance(tx, id, { lock: true });
      if (dto.amount < 0 && -dto.amount > before) {
        throw new UnprocessableEntityException({ code: 'BONUS_NOT_ENOUGH', message: `На счёте только ${before} сум`, balance_uzs: before });
      }
      const done = await this.bonus.manual(tx, id, dto.amount, dto.reason, me.staff.id, `manual:${randomUUID()}`);
      await this.audit.log(
        { staffId: me.staff.id, action: dto.amount > 0 ? 'customer.bonus_added' : 'customer.bonus_subtracted', entityType: 'user', entityId: id, before: { balance_uzs: before }, after: { amount_uzs: dto.amount, balance_uzs: done?.balance_uzs ?? before, reason: dto.reason } },
        tx,
      );
      return done;
    });
    return { balance_uzs: r?.balance_uzs ?? (await this.bonus.balance(this.prisma, id)) };
  }
}
