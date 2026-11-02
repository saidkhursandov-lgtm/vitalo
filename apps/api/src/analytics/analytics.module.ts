import { Body, Controller, HttpCode, Injectable, Module, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsIn, IsObject, IsOptional } from 'class-validator';
import { AuthModule } from '../auth/auth.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { PrismaService } from '../prisma/prisma.service';

/** Funnel steps in order (B3). The last three are written by the server itself, never by the app. */
export const FUNNEL_EVENTS = ['app_open', 'product_view', 'add_to_cart', 'checkout_start', 'order_created', 'payment_marked', 'payment_confirmed'] as const;
export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];
/**
 * Release 1: extra app events outside the funnel (counted separately in «Аналитика → Воронка»).
 * 2.1: payment_soon_click — a tap on Payme / Click / Uzum while it is «Скоро»; props.system = payme | click | uzum.
 * 2.4: manifest_open (props.source = home | ai_sheet), ai_tab_click — from the app; waitlist_subscribe,
 * waitlist_unsubscribe and waitlist_notified (props.product_id) — written by the server only.
 * 3.1: upsell_shown (props.count, props.source = auto | manual), upsell_add (props.product_id) — from the app;
 * receipt_sent, receipt_confirmed, receipt_rejected (props.order_id, props.reason) — written by the server only.
 * 3.2: notification_open (props.category, props.template), notification_read_all (props.count), active_order_click
 * (props.order_id, props.action = open | pay) — from the app; intake_guide_sent (props.order_id, props.products) — server only.
 * 3.3: promo_apply_success (props.code, props.discount_uzs, props.place = cart | checkout), promo_apply_fail (props.code,
 * props.reason), promo_remove (props.code, props.place) — from the app.
 * 3.4: compat_view (props.verdict, props.source, props.changed) — the answer card seen in the cart, from the app;
 * compat_request (props.products, props.has_comment, props.lang), compat_instant_answer (props.verdict), compat_answered
 * (props.verdict, props.via = bot | admin, props.minutes) — server only. The comment itself never goes to analytics (D-40).
 * 3.8 (VITALO AI, D-45): ai_consent; compat_ai_request (props.products, props.lang, props.verdict), compat_ai_cached
 * (props.verdict), compat_ai_limit, compat_ai_fallback (props.reason = invalid | error | budget | disabled) — server only.
 * 3.6: map_open (props.place = checkout | profile | cart), map_locate_me (props.result = ok | denied | unavailable),
 * map_confirm (props.place), map_district_auto (props.matched = true | false) — from the app. No coordinates in analytics.
 * 3.7: campaign_view (props.campaign_id, props.source = banner | link), campaign_banner_click (props.campaign_id),
 * campaign_add_to_cart (props.campaign_id, props.product_id, props.place = grid | product | campaign) — from the app.
 */
export const APP_EXTRA_EVENTS = ['language_change', 'cod_selected', 'payment_soon_click', 'manifest_open', 'ai_tab_click', 'upsell_shown', 'upsell_add', 'notification_open', 'notification_read_all', 'active_order_click', 'promo_apply_success', 'promo_apply_fail', 'promo_remove', 'compat_view', 'map_open', 'map_locate_me', 'map_confirm', 'map_district_auto', 'campaign_view', 'campaign_banner_click', 'campaign_add_to_cart'] as const;
export const SERVER_EXTRA_EVENTS = ['waitlist_subscribe', 'waitlist_unsubscribe', 'waitlist_notified', 'receipt_sent', 'receipt_confirmed', 'receipt_rejected', 'intake_guide_sent', 'compat_request', 'compat_instant_answer', 'compat_answered', 'ai_consent', 'compat_ai_request', 'compat_ai_cached', 'compat_ai_limit', 'compat_ai_fallback'] as const;
export const EXTRA_EVENTS = [...APP_EXTRA_EVENTS, ...SERVER_EXTRA_EVENTS] as const;
export const CLIENT_EVENTS = ['app_open', 'product_view', 'add_to_cart', 'checkout_start', ...APP_EXTRA_EVENTS] as const;

/** Spam protection: per user at most this many app events per minute; extra ones are dropped quietly. */
const LIMIT_PER_MINUTE = 30;
const MAX_PROPS = 8;

type Db = Prisma.TransactionClient | PrismaService;

/** Only short plain values survive: no nested objects, no long strings (nothing personal is needed here). */
export function cleanProps(props: unknown): Prisma.InputJsonObject | undefined {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(props).slice(0, MAX_PROPS)) {
    if (!/^[a-z_]{1,30}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 64);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export class TrackEventDto {
  @ApiProperty({ enum: CLIENT_EVENTS }) @IsIn(CLIENT_EVENTS) event!: (typeof CLIENT_EVENTS)[number];
  @ApiPropertyOptional({ example: { product_id: '…' } }) @IsOptional() @IsObject() props?: Record<string, unknown>;
}

@Injectable()
export class AnalyticsService {
  private readonly recent = new Map<string, number[]>();

  constructor(private readonly prisma: PrismaService) {}

  /** Server-side events (order created, payment marked / confirmed). Never fails the business action. */
  async track(userId: string, event: FunnelEvent | (typeof EXTRA_EVENTS)[number], props?: Record<string, unknown>, db: Db = this.prisma): Promise<void> {
    try {
      await db.analytics_events.create({ data: { user_id: userId, event, props: cleanProps(props) } });
    } catch {
      // analytics must not break orders
    }
  }

  /** Events sent by the Mini App; returns false when the user is over the limit. */
  async trackFromApp(userId: string, dto: TrackEventDto): Promise<boolean> {
    const now = Date.now();
    const times = (this.recent.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= LIMIT_PER_MINUTE) return false;
    times.push(now);
    this.recent.set(userId, times);
    if (this.recent.size > 10_000) this.recent.clear(); // memory guard
    await this.track(userId, dto.event, dto.props);
    return true;
  }

  /** Release 1: events outside the funnel since `from`: how many times and by how many users. */
  async extraEvents(from: Date) {
    const rows = await this.prisma.$queryRaw<{ event: string; users: bigint; events: bigint }[]>`
      SELECT event, COUNT(DISTINCT user_id) AS users, COUNT(*) AS events FROM analytics_events
      WHERE created_at >= ${from} AND event = ANY(${[...EXTRA_EVENTS]}::text[])
      GROUP BY event`;
    // which payment system customers wait for most: taps per system
    const bySystem = await this.prisma.$queryRaw<{ system: string; users: bigint; events: bigint }[]>`
      SELECT props->>'system' AS system, COUNT(DISTINCT user_id) AS users, COUNT(*) AS events FROM analytics_events
      WHERE created_at >= ${from} AND event = 'payment_soon_click' AND props->>'system' IS NOT NULL
      GROUP BY 1 ORDER BY 3 DESC`;
    // 3.3: why promo codes did not fit (min_order, expired, …), shown as sub-rows like the payment systems
    const byReason = await this.prisma.$queryRaw<{ system: string; users: bigint; events: bigint }[]>`
      SELECT props->>'reason' AS system, COUNT(DISTINCT user_id) AS users, COUNT(*) AS events FROM analytics_events
      WHERE created_at >= ${from} AND event = 'promo_apply_fail' AND props->>'reason' IS NOT NULL
      GROUP BY 1 ORDER BY 3 DESC`;
    // 3.6: the map — was the district found by itself; what «Моё местоположение» gave
    const byMap = await this.prisma.$queryRaw<{ event: string; system: string; users: bigint; events: bigint }[]>`
      SELECT event,
        CASE WHEN event = 'map_district_auto' THEN (CASE WHEN props->>'matched' = 'true' THEN 'district_auto' ELSE 'district_manual' END)
             ELSE 'locate_' || COALESCE(props->>'result', 'unknown') END AS system,
        COUNT(DISTINCT user_id) AS users, COUNT(*) AS events FROM analytics_events
      WHERE created_at >= ${from} AND event IN ('map_district_auto', 'map_locate_me')
      GROUP BY 1, 2 ORDER BY 4 DESC`;
    const sub = (b: { system: string; users: bigint; events: bigint }) => ({ system: b.system, users: Number(b.users), events: Number(b.events) });
    return EXTRA_EVENTS.map((event) => {
      const r = rows.find((x) => x.event === event);
      return {
        event,
        users: Number(r?.users ?? 0),
        events: Number(r?.events ?? 0),
        ...(event === 'payment_soon_click' && { by_system: bySystem.map(sub) }),
        ...(event === 'promo_apply_fail' && { by_system: byReason.map(sub) }),
        ...((event === 'map_district_auto' || event === 'map_locate_me') && { by_system: byMap.filter((b) => b.event === event).map(sub) }),
      };
    });
  }

  /** Unique users per step since `from` and the share that reached each step from the previous one. */
  async funnel(from: Date) {
    const rows = await this.prisma.$queryRaw<{ event: string; users: bigint }[]>`
      SELECT event, COUNT(DISTINCT user_id) AS users FROM analytics_events
      WHERE created_at >= ${from} AND event = ANY(${[...FUNNEL_EVENTS]}::text[])
      GROUP BY event`;
    const users = (e: string) => Number(rows.find((r) => r.event === e)?.users ?? 0);
    return FUNNEL_EVENTS.map((event, i) => {
      const n = users(event);
      const prev = i ? users(FUNNEL_EVENTS[i - 1]) : null;
      return { event, users: n, conversion_pct: prev === null ? null : prev ? Math.round((n / prev) * 1000) / 10 : null };
    });
  }
}

@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Post('events')
  @HttpCode(202)
  async track(@CurrentAuth() auth: AuthContext, @Body() dto: TrackEventDto) {
    return { accepted: await this.analytics.trackFromApp(auth.user.id, dto) };
  }
}

@Module({ imports: [AuthModule], controllers: [AnalyticsController], providers: [AnalyticsService], exports: [AnalyticsService] })
export class AnalyticsModule {}
