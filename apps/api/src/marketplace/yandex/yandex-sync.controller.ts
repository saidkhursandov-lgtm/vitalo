import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from '../../staff/staff-auth';
import { YandexSyncService } from './yandex-sync';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CloseAttentionDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

/** «Синхронизация Яндекса» — admin only (yandex.sync). */
@ApiTags('staff: yandex sync')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@RequirePermission('yandex.sync')
@Controller('staff/yandex-sync')
export class YandexSyncController {
  constructor(private readonly sync: YandexSyncService) {}

  @Get()
  status() {
    return this.sync.status();
  }

  /** «Проверить сейчас»: a run with the current mode (DRY_RUN unless switched off), also when the schedule is off. */
  @Post('run')
  @HttpCode(200)
  run(@CurrentStaff() me: StaffContext) {
    return this.sync.run({ trigger: 'manual', staffId: me.staff.id });
  }

  @Get('runs/:id')
  runDetails(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.sync.runDetails(id);
  }

  @Get('external/:id')
  external(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.sync.external(id);
  }

  @Post('attention/:id/close')
  @HttpCode(200)
  close(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CloseAttentionDto) {
    return this.sync.close(me.staff.id, id, dto.reason);
  }
}

/** Yandex sends notifications only from these networks (documentation «API-уведомления»). */
export const YANDEX_NOTIFY_NETWORKS = ['5.45.207.0/25', '141.8.142.0/25', '5.255.253.0/25'];

export function ipInNetworks(ip: string, networks = YANDEX_NOTIFY_NETWORKS): boolean {
  const v4 = ip.replace(/^::ffff:/, '');
  const toInt = (a: string) => a.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return false;
  return networks.some((net) => {
    const [base, bits] = net.split('/');
    const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (toInt(v4) & mask) === (toInt(base) & mask);
  });
}

const ORDER_EVENTS = ['ORDER_CREATED', 'ORDER_STATUS_UPDATED', 'ORDER_CANCELLED', 'ORDER_UPDATED'];

/**
 * Yandex API notifications (S2D-8), OFF by default (YANDEX_WEBHOOK_ENABLED=false → 404) and not registered in
 * Yandex. URL: https://<api>/api/yandex/notifications/<YANDEX_WEBHOOK_SECRET>.
 *
 * Yandex signs nothing, so: our secret in the path + the sender must be in Yandex's networks (behind nginx the
 * address comes from X-Real-IP; YANDEX_WEBHOOK_CHECK_IP=false turns that off for a manual test only). A
 * notification carries only the order number: we answer at once (PING within 1 s) and then fetch the order from
 * the API and process it exactly like the poll. A forged notification can at most trigger one extra read.
 */
@ApiExcludeController()
@Controller('yandex/notifications')
export class YandexWebhookController {
  constructor(
    private readonly sync: YandexSyncService,
    private readonly config: ConfigService,
  ) {}

  @Post(':secret')
  notify(@Param('secret') secret: string, @Req() req: Request, @Res() res: Response) {
    const cfg = this.sync.cfg();
    const expected = this.config.get<string>('YANDEX_WEBHOOK_SECRET')?.trim() ?? '';
    if (!cfg.webhookEnabled || expected.length < 16) throw new NotFoundException();
    const digest = (s: string) => createHash('sha256').update(s).digest();
    if (!timingSafeEqual(digest(secret), digest(expected))) throw new NotFoundException();
    const ip = (req.header('x-real-ip') ?? req.socket.remoteAddress ?? '').trim();
    if (cfg.webhookCheckIp && !ipInNetworks(ip)) {
      return res.status(403).json({ error: { type: 'UNKNOWN', message: 'Sender is not in Yandex networks' } });
    }

    const body = (req.body ?? {}) as { notificationType?: unknown; orderId?: unknown; campaignId?: unknown };
    const ok = { version: '2D', name: 'VITALO', time: new Date().toISOString() };
    if (body.notificationType === 'PING') return res.status(200).json(ok);
    if (typeof body.notificationType !== 'string') {
      return res.status(400).json({ error: { type: 'WRONG_EVENT_FORMAT', message: 'notificationType is required' } });
    }
    if (!ORDER_EVENTS.includes(body.notificationType)) return res.status(200).json(ok); // not about orders: nothing to do
    const orderId = body.orderId;
    if (typeof orderId !== 'number' || !Number.isInteger(orderId) || orderId <= 0 || typeof body.campaignId !== 'number') {
      return res.status(400).json({ error: { type: 'WRONG_EVENT_FORMAT', message: 'orderId and campaignId are required' } });
    }
    res.status(200).json(ok);
    if (!cfg.campaignIds.includes(body.campaignId)) return;
    // After the answer: the same processing as the poll; a failure here is caught by the next poll anyway.
    this.sync.lastWebhookJob = this.sync.run({ trigger: 'webhook', orderIds: [orderId] }).catch(() => undefined);
  }
}
