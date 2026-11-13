import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ReturnStatus } from '@prisma/client';
import type { Response } from 'express';
import { RETURN_REFUND_METHODS, RefundMethod } from '../returns/return-rules';
import { ReturnsService } from '../returns/returns.service';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

const STATUSES = Object.values(ReturnStatus);

class ReturnListQuery {
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: ReturnStatus;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page?: number;
}

class ApproveReturnDto {
  @ApiProperty({ description: 'Сумма к возврату, сум' }) @Type(() => Number) @IsInt() @Min(1) amount_uzs!: number;
}

class RejectReturnDto {
  @ApiProperty({ maxLength: 300 }) @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

class RefundedDto {
  @ApiProperty({ enum: RETURN_REFUND_METHODS }) @IsIn([...RETURN_REFUND_METHODS]) method!: RefundMethod;
  @ApiPropertyOptional({ maxLength: 300 }) @IsOptional() @IsString() @MaxLength(300) comment?: string;
}

/** 3.10-В: «Возвраты» — the customers' requests (admin and manager). */
@ApiTags('staff: returns')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/returns')
export class AdminReturnsController {
  constructor(
    private readonly returns: ReturnsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('returns.manage')
  list(@Query() q: ReturnListQuery) {
    return this.returns.staffList(q.status ?? 'requested', q.page ?? 1);
  }

  /** A photo of the request, with the staff token (never public). */
  @Get(':id/media/:mediaId')
  @RequirePermission('returns.manage')
  async media(@Param('id', new ParseUUIDPipe()) id: string, @Param('mediaId', new ParseUUIDPipe()) mediaId: string, @Res() res: Response) {
    const data = await this.returns.mediaFile(id, mediaId);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  }

  @Post(':id/approve')
  @RequirePermission('returns.manage')
  async approve(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ApproveReturnDto) {
    const r = await this.returns.approve(id, me.staff.id, dto.amount_uzs);
    await this.audit.log({ staffId: me.staff.id, action: 'return.approved', entityType: 'return', entityId: id, after: { amount_uzs: dto.amount_uzs, full_order: r.full_order, bonus_reversed_uzs: r.bonus_reversed_uzs, bonus_returned_uzs: r.bonus_returned_uzs, units: r.units } });
    return r;
  }

  @Post(':id/reject')
  @RequirePermission('returns.manage')
  async reject(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: RejectReturnDto) {
    const r = await this.returns.reject(id, me.staff.id, dto.reason);
    await this.audit.log({ staffId: me.staff.id, action: 'return.rejected', entityType: 'return', entityId: id, after: { reason: dto.reason } });
    return r;
  }

  @Post(':id/refunded')
  @RequirePermission('returns.manage')
  async refunded(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: RefundedDto) {
    const r = await this.returns.refunded(id, me.staff.id, dto.method, dto.comment);
    await this.audit.log({ staffId: me.staff.id, action: 'return.refunded', entityType: 'return', entityId: id, after: { method: dto.method, comment: dto.comment ?? null } });
    return r;
  }
}
