import { Body, Controller, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuthModule } from '../auth/auth.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../staff/audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from '../staff/staff-auth';
import type { notifications } from '@prisma/client';
import { CENTRE_CATEGORIES, centreStep, centreTab, renderCentre, type CentreTab, type Lang, type TemplatePayload } from './notification-templates';
import { quietUntil } from './notification-worker';

/** 3.2: the centre keeps 90 days. Older rows stay in the database (admin history), they are only not shown. */
export const CENTRE_DAYS = 90;
const PAGE = 50;
/** Rows read to build the cards (several rows of one order make one card). */
const ROWS = 300;

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

export interface CentreCard {
  id: string;
  tab: CentreTab;
  category: string | null;
  template: string;
  title: string;
  body: string;
  /** orders: «Принят → Оплачен → Собирается» */
  steps: string[];
  /** orders: «Как принимать ваш заказ» was sent — the memo is in the order card */
  has_guide: boolean;
  path: string | null;
  read: boolean;
  created_at: Date;
}

// where a tap leads: the order, the product or the promo link (the bot button opens the same page)
const pathOf = (n: notifications, p: TemplatePayload) =>
  p.open_path ?? (n.order_id ? `/orders/${n.order_id}` : n.product_id ? `/product/${n.product_id}` : null);

/**
 * After the owner's check (3.2): one card per order instead of a row per status — the latest status, the path of the
 * order, a note about the intake memo; it is unread while any of its messages is unread and goes up on every change.
 * The bot still sends a message per status (an edited Telegram message makes no sound). Other rows stay one card each.
 */
export function buildCards(rows: notifications[], lang: Lang): CentreCard[] {
  const cards: CentreCard[] = [];
  const byOrder = new Map<string, notifications[]>();
  for (const n of rows) {
    if (n.category === 'order' && n.order_id) {
      byOrder.set(n.order_id, [...(byOrder.get(n.order_id) ?? []), n]);
      continue;
    }
    const p = (n.payload ?? {}) as unknown as TemplatePayload;
    cards.push({ id: n.id, tab: centreTab(n.category), category: n.category, template: n.template, ...renderCentre(n.template, p, lang), steps: [], has_guide: false, path: pathOf(n, p), read: !!n.read_at, created_at: n.created_at });
  }
  for (const list of byOrder.values()) {
    const asc = [...list].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    const latest = asc[asc.length - 1];
    // the card text is the latest message about the order; the memo is only a note under it
    const main = [...asc].reverse().find((n) => n.template !== 'order.intake_guide') ?? latest;
    const p = (main.payload ?? {}) as unknown as TemplatePayload;
    const steps: string[] = [];
    for (const n of asc) {
      const s = centreStep(n.template, lang);
      if (s && steps[steps.length - 1] !== s) steps.push(s);
    }
    cards.push({
      id: latest.id,
      tab: 'orders',
      category: 'order',
      template: main.template,
      ...renderCentre(main.template, p, lang),
      steps,
      has_guide: asc.some((n) => n.template === 'order.intake_guide'),
      // 6а-А: an order card always opens the order itself — its screen has the right «Оплатить» for the payment method;
      // a stored «/orders/:id/pay» (card transfer screen) opened a Payme order as «Что-то пошло не так»
      path: `/orders/${main.order_id}`,
      read: asc.every((n) => n.read_at),
      created_at: latest.created_at,
    });
  }
  return cards.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}

/** Unread cards per tab; the bell shows the sum — one per order, not one per message. */
function counts(cards: CentreCard[]) {
  const tabs: Record<CentreTab, number> = { personal: 0, orders: 0, promo: 0, service: 0 };
  for (const c of cards) if (!c.read) tabs[c.tab]++;
  return { unread: tabs.personal + tabs.orders + tabs.promo + tabs.service, tabs };
}

@Injectable()
export class NotificationCentreService {
  constructor(private readonly prisma: PrismaService) {}

  private async cards(userId: string, lang: Lang) {
    const rows = await this.prisma.notifications.findMany({ where: centreWhere(userId, new Date()), orderBy: { created_at: 'desc' }, take: ROWS });
    return buildCards(rows, lang);
  }

  async list(userId: string, lang: Lang, limit = PAGE) {
    const cards = await this.cards(userId, lang);
    return { ...counts(cards), items: cards.slice(0, limit) };
  }

  async unread(userId: string) {
    return counts(await this.cards(userId, 'ru'));
  }

  /** Opening an order card marks every message of that order read. */
  async read(userId: string, id: string) {
    const n = await this.prisma.notifications.findFirst({ where: { id, user_id: userId }, select: { id: true, order_id: true, category: true } });
    if (!n) throw new NotFoundException('Notification not found');
    const where = n.category === 'order' && n.order_id ? { user_id: userId, order_id: n.order_id, category: 'order' } : { id };
    await this.prisma.notifications.updateMany({ where: { ...where, read_at: null }, data: { read_at: new Date() } });
    return this.unread(userId);
  }

  async readAll(userId: string) {
    const res = await this.prisma.notifications.updateMany({ where: { ...centreWhere(userId, new Date()), read_at: null }, data: { read_at: new Date() } });
    return { marked: res.count, unread: 0, tabs: { personal: 0, orders: 0, promo: 0, service: 0 } };
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

/** Аудит 4.2: who gets the promo — always only customers with «Получать акции и новости». */
export const PROMO_SEGMENTS = ['all', 'bought', 'waiting', 'inactive'] as const;
export type PromoSegment = (typeof PROMO_SEGMENTS)[number];

export class PromoAudienceQuery {
  @ApiPropertyOptional({ enum: PROMO_SEGMENTS, default: 'all' }) @IsOptional() @IsIn(PROMO_SEGMENTS) segment?: PromoSegment;
  /** bought / waiting: the product */
  @ApiPropertyOptional() @ValidateIf((o) => o.segment === 'bought' || o.segment === 'waiting') @IsUUID() product_id?: string;
  /** inactive: no order for this many days */
  @ApiPropertyOptional({ default: 30 }) @IsOptional() @Type(() => Number) @IsInt() @Min(7) @Max(365) days?: number;
}

export class SendPromoDto extends PromoAudienceQuery {
  /** Аудит 4.2: «Отправить себе» — only to the employee's own Telegram, at once; nobody else gets it */
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === true || value === 'true') @IsBoolean() to_me?: boolean;
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

  /** Аудит 4.2: the subscribed customers of one group. */
  private where(q: PromoAudienceQuery, now = new Date()): Prisma.usersWhereInput {
    const paid = ['paid', 'picking', 'handed_to_delivery', 'in_transit', 'delivered'] as const;
    switch (q.segment ?? 'all') {
      case 'bought':
        return { ...PROMO_AUDIENCE, orders: { some: { status: { in: [...paid] }, items: { some: { product_id: q.product_id } } } } };
      case 'waiting':
        return { ...PROMO_AUDIENCE, waitlist: { some: { product_id: q.product_id, notified_at: null, cancelled_at: null } } };
      case 'inactive':
        return { ...PROMO_AUDIENCE, orders: { none: { created_at: { gte: new Date(now.getTime() - (q.days ?? 30) * 86_400_000) } } } };
      default:
        return PROMO_AUDIENCE;
    }
  }

  async audience(q: PromoAudienceQuery = {}) {
    return { recipients: await this.prisma.users.count({ where: this.where(q) }) };
  }

  /** Аудит 4.2: the last sends with how many were delivered and opened in the Mini App centre. */
  async history() {
    const logs = await this.prisma.audit_logs.findMany({ where: { action: 'promo.sent' }, orderBy: { created_at: 'desc' }, take: 30, include: { staff: { select: { name: true } } } });
    const ids = logs.map((l) => l.entity_id).filter((x): x is string => !!x);
    const stats = ids.length
      ? await this.prisma.$queryRaw<{ campaign: string; total: bigint; sent: bigint; failed: bigint; read: bigint }[]>`
          SELECT split_part(dedup_key, ':', 2) AS campaign, COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE status = 'sent') AS sent,
                 COUNT(*) FILTER (WHERE status IN ('failed', 'skipped')) AS failed,
                 COUNT(read_at) AS read
          FROM notifications
          WHERE template = 'promo.message' AND user_id IS NOT NULL AND split_part(dedup_key, ':', 2) = ANY(${ids})
          GROUP BY 1`
      : [];
    return logs.map((l) => {
      const a = (l.after_json ?? {}) as { title_ru?: string; recipients?: number; scheduled_at?: string; segment?: string; segment_label?: string };
      const s = stats.find((x) => x.campaign === l.entity_id);
      return {
        id: l.entity_id,
        created_at: l.created_at,
        staff_name: l.staff?.name ?? null,
        title_ru: a.title_ru ?? '',
        segment: a.segment_label ?? 'Все подписанные',
        recipients: a.recipients ?? 0,
        scheduled_at: a.scheduled_at ?? null,
        sent: Number(s?.sent ?? 0),
        failed: Number(s?.failed ?? 0),
        read: Number(s?.read ?? 0),
      };
    });
  }

  private async segmentLabel(q: PromoAudienceQuery): Promise<string> {
    const seg = q.segment ?? 'all';
    if (seg === 'inactive') return `Без заказов ${q.days ?? 30} дней`;
    if (seg === 'bought' || seg === 'waiting') {
      const p = await this.prisma.products.findUnique({ where: { id: q.product_id }, select: { sku: true } });
      if (!p) throw new NotFoundException('Product not found');
      return `${seg === 'bought' ? 'Купили' : 'Ждут'} ${p.sku}`;
    }
    return 'Все подписанные';
  }

  /**
   * One marketing row per customer: the bot message (not at night — the worker waits until 08:00) and a «promo»
   * entry in the centre. The opt-out is checked again right before sending.
   */
  async send(staffId: string, dto: SendPromoDto, now = new Date()) {
    const path = linkPath(dto.link);
    const clean = (s?: string) => s?.trim() || undefined;
    const content = {
      order_number: '',
      title_ru: dto.title_ru.trim(),
      title_uz: clean(dto.title_uz),
      text_ru: dto.text_ru.trim(),
      text_uz: clean(dto.text_uz),
      ...(path && { open_path: path, open_button: 'link' }),
    };
    const label = await this.segmentLabel(dto);
    if (dto.to_me) {
      // аудит 4.2: a test to the employee's own Telegram, at once (no quiet hours); not in the history of sends
      const me = await this.prisma.staff_users.findUniqueOrThrow({ where: { id: staffId }, select: { telegram_user_id: true } });
      await this.prisma.notifications.create({
        data: { staff_user_id: staffId, chat_id: me.telegram_user_id, kind: 'service', template: 'promo.message', next_attempt_at: now, payload: { ...content, lang: 'ru' } },
      });
      return { campaign: null, recipients: 1, scheduled_at: now, deferred: false, to_me: true, would_reach: (await this.audience(dto)).recipients };
    }
    const users = await this.prisma.users.findMany({ where: this.where(dto, now), select: { id: true, telegram_user_id: true, language: true } });
    const campaign = randomUUID();
    const at = quietUntil(now) ?? now;
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
          payload: { ...content, lang: u.language },
        })),
        skipDuplicates: true,
      });
      await this.audit.log(
        { staffId, action: 'promo.sent', entityType: 'promo', entityId: campaign, after: { title_ru: dto.title_ru, recipients: users.length, scheduled_at: at.toISOString(), link: dto.link ?? null, segment: dto.segment ?? 'all', segment_label: label, product_id: dto.product_id ?? null, days: dto.segment === 'inactive' ? (dto.days ?? 30) : null } },
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
  audience(@Query() q: PromoAudienceQuery) {
    return this.promo.audience(q);
  }

  /** Аудит 4.2: the history of sends (delivered, opened in the Mini App). */
  @Get('history')
  @RequirePermission('promo.send')
  history() {
    return this.promo.history();
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
