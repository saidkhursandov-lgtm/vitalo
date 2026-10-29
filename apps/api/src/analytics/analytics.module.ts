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
/** Release 1: extra app events outside the funnel (counted separately in «Аналитика → Воронка»). */
export const EXTRA_EVENTS = ['language_change', 'cod_selected'] as const;
export const CLIENT_EVENTS = ['app_open', 'product_view', 'add_to_cart', 'checkout_start', ...EXTRA_EVENTS] as const;

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
    return EXTRA_EVENTS.map((event) => {
      const r = rows.find((x) => x.event === event);
      return { event, users: Number(r?.users ?? 0), events: Number(r?.events ?? 0) };
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
