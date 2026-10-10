import { Controller, Get, Injectable, Module, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { yandexSyncConfig } from '../marketplace/yandex/yandex-sync';
import { PrismaService } from '../prisma/prisma.service';

export interface HealthReport {
  /** ok — everything works; degraded — the shop answers, but something needs a look (HTTP 503 too, so a monitor alerts) */
  status: 'ok' | 'degraded' | 'down';
  time: string;
  db: boolean;
  yandex_sync: { enabled: boolean; minutes_since_last: number | null; max_minutes: number; stale: boolean };
}

/** A poll is «too old» after three missed intervals plus five minutes (15 → 50 min, 5 → 20 min). */
export const maxSyncAgeMinutes = (intervalMinutes: number) => intervalMinutes * 3 + 5;

/**
 * What a monitor needs and nothing more: no versions, no names, no counts, no settings. `lastSyncAt` — the last
 * finished run without an error; when there is none yet, the age is counted from the start of the process.
 */
export function buildHealth(input: { dbOk: boolean; syncEnabled: boolean; intervalMinutes: number; lastSyncAt: Date | null; startedAt: Date; now: Date }): HealthReport {
  const max = maxSyncAgeMinutes(input.intervalMinutes);
  const since = input.lastSyncAt ?? input.startedAt;
  const minutes = Math.max(0, Math.floor((input.now.getTime() - since.getTime()) / 60_000));
  const stale = input.syncEnabled && input.dbOk && minutes > max;
  return {
    status: !input.dbOk ? 'down' : stale ? 'degraded' : 'ok',
    time: input.now.toISOString(),
    db: input.dbOk,
    yandex_sync: { enabled: input.syncEnabled, minutes_since_last: input.syncEnabled && input.lastSyncAt ? minutes : null, max_minutes: max, stale },
  };
}

@Injectable()
export class HealthService {
  private readonly startedAt = new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async check(now = new Date()): Promise<HealthReport> {
    const cfg = yandexSyncConfig(this.config);
    // the poll runs only where the background jobs run
    const syncEnabled = cfg.enabled && process.env.JOBS_ENABLED !== 'false';
    let dbOk = true;
    let lastSyncAt: Date | null = null;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      if (syncEnabled) {
        const last = await this.prisma.yandex_sync_runs.findFirst({ where: { finished_at: { not: null }, error: null }, orderBy: { finished_at: 'desc' }, select: { finished_at: true } });
        lastSyncAt = last?.finished_at ?? null;
      }
    } catch {
      dbOk = false;
    }
    return buildHealth({ dbOk, syncEnabled, intervalMinutes: cfg.intervalMinutes, lastSyncAt, startedAt: this.startedAt, now });
  }
}

/**
 * GET /api/health — public, for an external monitor (UptimeRobot and the like) and scripts/server/healthcheck.sh.
 * 200 when everything is fine, 503 when the database does not answer or the Yandex poll is switched on and stale.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async get(@Res() res: Response) {
    const report = await this.health.check();
    res.status(report.status === 'ok' ? 200 : 503).setHeader('Cache-Control', 'no-store').json(report);
  }
}

@Module({ controllers: [HealthController], providers: [HealthService] })
export class HealthModule {}
