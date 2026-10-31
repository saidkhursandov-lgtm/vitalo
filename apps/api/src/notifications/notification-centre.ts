import { Body, Controller, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { randomUUID } from 'crypto';
import { AuthModule } from '../auth/auth.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../staff/audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from '../staff/staff-auth';
import { CENTRE_CATEGORIES, renderCentre, type TemplatePayload } from './notification-templates';
import { quietUntil } from './notification-worker';

/** 3.2: the centre keeps 90 days. Older rows stay in the database (admin history), they are only not shown. */
export const CENTRE_DAYS = 90;
const PAGE = 50;

/**
 * Rows the customer sees in the centre: their own, of a shown section, not older than 90 days. A promo appears only
 * once it may be sent (not at night) and not when it was skipped (the customer turned promos off).
 */
function centreWhere(userId: string, now: Date) {
  return {
    user_id: userId,
    category: { in: [...CENTRE_CATEGORIES] },
    created_at: { gte: new Date(now.getTime() - CENTRE_DAYS * 24 * 3600_000) },
    next_attempt_at: { lte: now },
    status: { not: 'skipped' },
  };
}

@Injectable()
export class NotificationCentreService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, lang: 'ru' | 'uz', limit = PAGE) {
    const now = new Date();
    const where = centreWhere(userId, now);
    const [rows, unread] = await this.prisma.$transaction([
      this.prisma.notifications.findMany({ where, orderBy: { created_at: 'desc' }, take: limit }),
      this.prisma.notifications.count({ where: { ...where, read_at: null } }),
    ]);
    return {
      unread,
      items: rows.map((n) => {
        const payload = (n.payload ?? {}) as unknown as TemplatePayload;
        return {
          id: n.id,
          category: n.category,
          template: n.template,
          ...renderCentre(n.template, payload, lang),
          // where a tap leads: the order, the product or the promo link (the bot button opens the same page)
          path: payload.open_path ?? (n.order_id ? `/orders/${n.order_id}` : n.product_id ? `/product/${n.product_id}` : null),
          read: !!n.read_at,
          created_at: n.created_at,
        };
      }),
    };
  }

  async unread(userId: string) {
    return { unread: await this.prisma.notifications.count({ where: { ...centreWhere(userId, new Date()), read_at: null } }) };
  }

  async read(userId: string, id: string) {
    const n = await this.prisma.notifications.findFirst({ where: { id, user_id: userId }, select: { id: true, read_at: true } });
    if (!n) throw new NotFoundException('Notification not found');
    if (!n.read_at) await this.prisma.notifications.update({ where: { id }, data: { read_at: new Date() } });
    return this.unread(userId);
  }

  async readAll(userId: string) {
    const res = await this.prisma.notifications.updateMany({ where: { ...centreWhere(userId, new Date()), read_at: null }, data: { read_at: new Date() } });
    return { marked: res.count, unread: 0 };
  }
}

class CentreQuery {
  @ApiPropertyOptional({ enum: ['ru', 'uz'] }) @IsOptional() @IsIn(['ru', 'uz']) lang?: 'ru' | 'uz';
  @ApiPropertyOptional({ default: PAGE }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('notifications')
export class NotificationCentreController {
  constructor(private readonly centre: NotificationCentreService) {}

  /** Newest first; language from the query (the Mini App switch), else the customer's saved language. */
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() q: CentreQuery) {
    return this.centre.list(auth.user.id, q.lang ?? (auth.user.language === 'uz' ? 'uz' : 'ru'), q.limit);
  }

  @Get('unread')
  unread(@CurrentAuth() auth: AuthContext) {
    return this.centre.unread(auth.user.id);
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@CurrentAuth() auth: AuthContext) {
    return this.centre.readAll(auth.user.id);
  }

  @Post(':id/read')
  @HttpCode(200)
  read(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.centre.read(auth.user.id, id);
  }
}

// ───────────── Promos from the admin panel ─────────────

class PromoLinkDto {
  @ApiProperty({ enum: ['product', 'category', 'brand'] }) @IsIn(['product', 'category', 'brand']) type!: 'product' | 'category' | 'brand';
  @ApiProperty({ description: 'id товара, slug категории или адрес бренда' }) @IsString() @MinLength(1) @MaxLength(120) value!: string;
}

export class SendPromoDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) title_ru!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) title_uz?: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(600) text_ru!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(600) text_uz?: string;
  @ApiPropertyOptional({ type: PromoLinkDto }) @IsOptional() @ValidateNested() @Type(() => PromoLinkDto) link?: PromoLinkDto;
}

/** Same rules as the home banners (Mini App bannerHref). */
function linkPath(link?: PromoLinkDto): string | undefined {
  if (!link) return undefined;
  if (link.type === 'product') return `/product/${link.value}`;
  if (link.type === 'category') return `/catalog/products?category=${encodeURIComponent(link.value)}`;
  return `/brand/${encodeURIComponent(link.value)}`;
}

/** Customers who get promos: active, not deleted, «Получать акции и новости» on. */
const PROMO_AUDIENCE = { status: 'active', deleted_at: null, marketing_opt_in: true } as const;

@Injectable()
export class PromoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async audience() {
    return { recipients: await this.prisma.users.count({ where: PROMO_AUDIENCE }) };
  }

  /**
   * One marketing row per customer: the bot message (not at night — the worker waits until 08:00) and a «promo»
   * entry in the centre. The opt-out is checked again right before sending.
   */
  async send(staffId: string, dto: SendPromoDto, now = new Date()) {
    const users = await this.prisma.users.findMany({ where: PROMO_AUDIENCE, select: { id: true, telegram_user_id: true, language: true } });
    const campaign = randomUUID();
    const at = quietUntil(now) ?? now;
    const path = linkPath(dto.link);
    const clean = (s?: string) => s?.trim() || undefined;
    await this.prisma.$transaction(async (tx) => {
      await tx.notifications.createMany({
        data: users.map((u) => ({
          user_id: u.id,
          chat_id: u.telegram_user_id,
          kind: 'marketing',
          category: 'promo',
          template: 'promo.message',
          next_attempt_at: at,
          dedup_key: `promo:${campaign}:${u.id}`,
          payload: {
            order_number: '',
            lang: u.language,
            title_ru: dto.title_ru.trim(),
            title_uz: clean(dto.title_uz),
            text_ru: dto.text_ru.trim(),
            text_uz: clean(dto.text_uz),
            ...(path && { open_path: path, open_button: 'link' }),
          },
        })),
        skipDuplicates: true,
      });
      await this.audit.log(
        { staffId, action: 'promo.sent', entityType: 'promo', entityId: campaign, after: { title_ru: dto.title_ru, recipients: users.length, scheduled_at: at.toISOString(), link: dto.link ?? null } },
        tx,
      );
    });
    return { campaign, recipients: users.length, scheduled_at: at, deferred: at.getTime() > now.getTime() };
  }
}

@ApiTags('staff: promo')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/promo')
export class PromoController {
  constructor(private readonly promo: PromoService) {}

  /** How many customers will get the promo now. */
  @Get('audience')
  @RequirePermission('promo.send')
  audience() {
    return this.promo.audience();
  }

  @Post()
  @HttpCode(200)
  @RequirePermission('promo.send')
  send(@CurrentStaff() me: StaffContext, @Body() dto: SendPromoDto) {
    return this.promo.send(me.staff.id, dto);
  }
}

/** Customer side. PromoController / PromoService are registered in StaffModule (StaffGuard lives there). */
@Module({
  imports: [AuthModule],
  controllers: [NotificationCentreController],
  providers: [NotificationCentreService],
})
export class NotificationCentreModule {}
