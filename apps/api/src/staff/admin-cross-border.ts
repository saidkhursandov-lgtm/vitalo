import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { BATCH_MANUAL_STAGES, CROSS_BORDER_SETTINGS_KEY, loadCrossBorderSettings, mergeCrossBorderSettings, type CrossBorderSettings } from '../orders/cross-border';
import { CrossBorderService } from '../orders/cross-border.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

class CreateBatchDto {
  @ApiProperty({ type: [String], description: 'Строки заказов «из США», которые заказаны на iHerb' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('4', { each: true }) item_ids!: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) note?: string;
  @ApiPropertyOptional({ description: 'Закупка, по которой посылку примут на складе' }) @IsOptional() @IsUUID() purchase_id?: string;
}

class AddItemsDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('4', { each: true }) item_ids!: string[];
}

class BatchStageDto {
  @ApiProperty({ enum: BATCH_MANUAL_STAGES }) @IsIn(BATCH_MANUAL_STAGES) stage!: (typeof BATCH_MANUAL_STAGES)[number];
}

class BatchPurchaseDto {
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() purchase_id?: string | null;
}

class MoveDateDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() batch_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() order_id?: string;
  @ApiProperty({ example: '2026-11-30' }) @Matches(/^\d{4}-\d{2}-\d{2}$/) expected_to!: string;
  @ApiProperty({ description: 'Причина — её прочитает покупатель' }) @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

class CrossBorderSettingsDto implements Partial<CrossBorderSettings> {
  @ApiPropertyOptional({ description: 'Срок «из США» от оплаты: с, дней' }) @IsOptional() @IsInt() @Min(1) @Max(90) days_min?: number;
  @ApiPropertyOptional({ description: 'Срок «из США» от оплаты: по, дней' }) @IsOptional() @IsInt() @Min(1) @Max(120) days_max?: number;
  @ApiPropertyOptional({ description: 'Гарантия: через столько дней после оплаты без товара на складе покупатель может сам отменить' })
  @IsOptional() @IsInt() @Min(1) @Max(180) guarantee_days?: number;
}

/** D-60: «Посылки из США» in the admin panel. */
@ApiTags('staff: cross-border')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/cross-border')
export class AdminCrossBorderController {
  constructor(
    private readonly cb: CrossBorderService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('waiting')
  @RequirePermission('cross_border.view')
  waiting() {
    return this.cb.waiting();
  }

  @Get('batches')
  @RequirePermission('cross_border.view')
  batches() {
    return this.cb.batches();
  }

  @Get('batches/:id')
  @RequirePermission('cross_border.view')
  batch(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.cb.batch(id);
  }

  @Post('batches')
  @RequirePermission('cross_border.manage')
  createBatch(@CurrentStaff() me: StaffContext, @Body() dto: CreateBatchDto) {
    return this.cb.createBatch(me.staff.id, dto);
  }

  @Post('batches/:id/items')
  @HttpCode(200)
  @RequirePermission('cross_border.manage')
  addItems(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AddItemsDto) {
    return this.cb.addToBatch(me.staff.id, id, dto.item_ids);
  }

  @Post('batches/:id/stage')
  @HttpCode(200)
  @RequirePermission('cross_border.manage')
  stage(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: BatchStageDto) {
    return this.cb.setBatchStage(me.staff.id, id, dto.stage);
  }

  @Put('batches/:id/purchase')
  @RequirePermission('cross_border.manage')
  purchase(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: BatchPurchaseDto) {
    return this.cb.setBatchPurchase(me.staff.id, id, dto.purchase_id ?? null);
  }

  /** «Отдать банки со склада»: the Tashkent stock goes to a waiting line before its parcel comes. */
  @Post('items/:id/attach')
  @HttpCode(200)
  @RequirePermission('cross_border.manage')
  async attach(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.cb.attachFromStock(me.staff.id, id);
    return { ok: true };
  }

  @Post('move-date')
  @HttpCode(200)
  @RequirePermission('cross_border.manage')
  moveDate(@CurrentStaff() me: StaffContext, @Body() dto: MoveDateDto) {
    return this.cb.moveDate(me.staff.id, dto);
  }

  @Get('settings')
  @RequirePermission('cross_border.view')
  settings() {
    return loadCrossBorderSettings(this.prisma);
  }

  @Put('settings')
  @RequirePermission('settings.manage')
  async setSettings(@CurrentStaff() me: StaffContext, @Body() dto: CrossBorderSettingsDto) {
    const before = await loadCrossBorderSettings(this.prisma);
    const value = mergeCrossBorderSettings({ ...before, ...Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) });
    const json = value as unknown as Prisma.InputJsonValue;
    await this.prisma.$transaction(async (tx) => {
      await tx.settings.upsert({ where: { key: CROSS_BORDER_SETTINGS_KEY }, create: { key: CROSS_BORDER_SETTINGS_KEY, value: json }, update: { value: json } });
      await this.audit.log({ staffId: me.staff.id, action: 'settings.cross_border_updated', entityType: 'settings', before, after: value }, tx);
    });
    return value;
  }
}
