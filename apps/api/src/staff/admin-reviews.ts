import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ReviewStatus } from '@prisma/client';
import type { Response } from 'express';
import { REVIEW_REJECT_REASONS, ReviewRejectReason } from '../reviews/review-rules';
import { ReviewsService } from '../reviews/reviews.service';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

const STATUSES = Object.values(ReviewStatus);
const REASONS = Object.keys(REVIEW_REJECT_REASONS) as ReviewRejectReason[];

class ReviewListQuery {
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: ReviewStatus;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page?: number;
}

class RejectReviewDto {
  @ApiProperty({ enum: REASONS }) @IsIn(REASONS) reason!: ReviewRejectReason;
  @ApiPropertyOptional({ maxLength: 300 }) @IsOptional() @IsString() @MaxLength(300) note?: string;
}

class ReplyReviewDto {
  @ApiProperty({ maxLength: 1000, description: 'Пустой текст убирает ответ' }) @IsString() @MaxLength(1000) text!: string;
}

/** 3.10-Б: «Отзывы» — premoderation (admin and specialists). */
@ApiTags('staff: reviews')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/reviews')
export class AdminReviewsController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('reviews.moderate')
  list(@Query() q: ReviewListQuery) {
    return this.reviews.staffList(q.status ?? 'pending', q.page ?? 1);
  }

  /** The photo itself, loaded with the staff token (not public until the review is published). */
  @Get(':id/media/:mediaId')
  @RequirePermission('reviews.moderate')
  async media(@Param('id', new ParseUUIDPipe()) id: string, @Param('mediaId', new ParseUUIDPipe()) mediaId: string, @Res() res: Response) {
    const data = await this.reviews.mediaFile(id, mediaId);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  }

  @Post(':id/publish')
  @RequirePermission('reviews.moderate')
  async publish(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.reviews.publish(id, me.staff.id);
    await this.audit.log({ staffId: me.staff.id, action: r.first ? 'review.published' : 'review.unhidden', entityType: 'review', entityId: id, after: { bonus_uzs: r.bonus_uzs } });
    return r;
  }

  @Post(':id/reject')
  @RequirePermission('reviews.moderate')
  async reject(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: RejectReviewDto) {
    const r = await this.reviews.reject(id, me.staff.id, dto.reason, dto.note);
    await this.audit.log({ staffId: me.staff.id, action: 'review.rejected', entityType: 'review', entityId: id, after: { reason: dto.reason, note: dto.note ?? null } });
    return r;
  }

  @Post(':id/hide')
  @RequirePermission('reviews.moderate')
  async hide(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.reviews.hide(id, me.staff.id);
    await this.audit.log({ staffId: me.staff.id, action: 'review.hidden', entityType: 'review', entityId: id });
    return r;
  }

  @Put(':id/reply')
  @RequirePermission('reviews.moderate')
  async reply(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ReplyReviewDto) {
    const r = await this.reviews.reply(id, me.staff.id, dto.text);
    await this.audit.log({ staffId: me.staff.id, action: 'review.replied', entityType: 'review', entityId: id, after: { text: r.reply } });
    return r;
  }
}
