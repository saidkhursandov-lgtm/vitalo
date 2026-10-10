import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketplaceOrderStatus, Prisma } from '@prisma/client';
import { NotificationsService } from '../../notifications/notifications.service';
import { SystemErrorsService } from '../../notifications/system-errors';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../staff/audit.service';
import { findProductsBySkus } from '../../staff/sku-aliases';
import { YandexOrdersService } from '../yandex-orders';
import { YandexApiError, YandexMarketClient, type FetchLike } from './yandex-client';
import {
  ATTENTION_RU,
  CREATE_STATUS,
  LATE_STATUSES,
  minimizeYandexOrder,
  parseYandexOrder,
  RETURN_STATUSES,
  WAIT_STATUSES,
  yandexStatusRu,
  type AttentionKind,
  type ParsedYandexOrder,
} from './yandex-order';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

/** Overridden in tests: a fake fetch fed by fixtures and no pauses. Never a real request to Yandex in tests. */
export const YANDEX_CLIENT_OPTIONS = Symbol('YANDEX_CLIENT_OPTIONS');
export interface YandexClientTestOptions {
  fetch?: FetchLike;
  retryDelaysMs?: number[];
}

/** Settings from apps/api/.env (S2D-*). The token itself is only ever checked for presence here. */
export function yandexSyncConfig(config: Pick<ConfigService, 'get'>) {
  const int = (name: string, def: number, min: number, max: number) => {
    const v = Number(config.get<string>(name));
    return Number.isInteger(v) && v >= min && v <= max ? v : def;
  };
  const campaigns = (config.get<string>('YANDEX_CAMPAIGN_IDS') ?? '149165806')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x > 0);
  return {
    tokenSet: !!config.get<string>('YANDEX_API_KEY')?.trim(),
    businessId: int('YANDEX_BUSINESS_ID', 216755072, 1, Number.MAX_SAFE_INTEGER),
    campaignIds: campaigns.length ? campaigns : [149165806],
    enabled: config.get<string>('YANDEX_SYNC_ENABLED') === 'true',
    dryRun: config.get<string>('YANDEX_SYNC_DRY_RUN') !== 'false', // anything but an explicit false is DRY_RUN
    intervalMinutes: int('YANDEX_SYNC_INTERVAL_MINUTES', 5, 1, 1440),
    days: int('YANDEX_SYNC_DAYS', 3, 1, 30),
    firstDays: int('YANDEX_SYNC_FIRST_DAYS', 14, 1, 30),
    webhookEnabled: config.get<string>('YANDEX_WEBHOOK_ENABLED') === 'true',
    webhookSecretSet: (config.get<string>('YANDEX_WEBHOOK_SECRET')?.trim().length ?? 0) >= 16,
    webhookCheckIp: config.get<string>('YANDEX_WEBHOOK_CHECK_IP') !== 'false',
  };
}
export type YandexSyncConfig = ReturnType<typeof yandexSyncConfig>;

type Mode = 'DRY_RUN' | 'LIVE';
type Trigger = 'schedule' | 'manual' | 'webhook';

/** What the sync does (LIVE) or would do (DRY_RUN) with one Yandex order. */
type Plan =
  | { type: 'skip'; reason: string }
  | { type: 'closed' }
  | { type: 'create'; lines: { product_id: string; sku: string; qty: number; unit_price_uzs?: number }[]; enough: boolean; byAlias: string[] }
  | { type: 'attention'; kind: AttentionKind; reason: string }
  | { type: 'sync'; orderId: string; then: 'cancel' | 'return' | null; attention?: { kind: AttentionKind; reason: string } };

export interface RunDetail {
  number: string | null;
  status?: string;
  action: string;
  reason?: string;
}

const MAX_DETAILS = 500;

/**
 * Stage 2D: Yandex orders arrive by themselves — read only (S2D-3). A poll every N minutes (and «Проверить
 * сейчас», and the notification endpoint for one order) runs the SAME processing:
 *
 * - new order in PROCESSING → our Yandex order (2C) «Новый», lines by offerId = SKU, units by FEFO (all or
 *   nothing; not enough → created without units, «Не хватает остатка»); warehouse and admin get a message;
 * - Yandex cancelled → our cancellation (before the handover) or a return for a check (after it), by 2C rules;
 * - other Yandex statuses are only shown; our statuses are moved by employees;
 * - unknown SKU, product without units, not UZS, broken data, first seen already shipped/cancelled, a Yandex
 *   return → «Требует внимания» (admin), with the raw answer; «Закрыть как неактуальный» stops it for good.
 *
 * Every Yandex order is processed in its own transaction under an advisory lock on its number: one bad order
 * never breaks the batch, and a poll and a notification for the same order never run it twice at once.
 * DRY_RUN writes nothing but the run log («что было бы сделано»).
 */
@Injectable()
export class YandexSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(YandexSyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private active = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** The last client (its rate limit info is shown on the sync screen). */
  private lastClient: YandexMarketClient | null = null;
  /** For tests: the background processing started by the last notification. */
  lastWebhookJob: Promise<unknown> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly orders: YandexOrdersService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly errors: SystemErrorsService,
    @Optional() @Inject(YANDEX_CLIENT_OPTIONS) private readonly clientOptions?: YandexClientTestOptions,
  ) {}

  cfg(): YandexSyncConfig {
    return yandexSyncConfig(this.config);
  }

  onModuleInit() {
    const cfg = this.cfg();
    if (!cfg.enabled || process.env.JOBS_ENABLED === 'false') return;
    const tick = () => void this.run({ trigger: 'schedule' }).catch((e: Error) => this.logger.error(`Yandex sync failed: ${this.safe(e.message)}`));
    this.timer = setInterval(tick, cfg.intervalMinutes * 60_000);
    setTimeout(tick, 30_000).unref();
    this.logger.log(`Yandex sync: every ${cfg.intervalMinutes} min, ${cfg.dryRun ? 'DRY_RUN' : 'LIVE'}, campaigns ${cfg.campaignIds.join(', ')}`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private client(): YandexMarketClient {
    this.lastClient = new YandexMarketClient({
      apiKey: this.config.get<string>('YANDEX_API_KEY')?.trim() || undefined,
      // Second lock: under NODE_ENV=test a request can only go to an injected fake — never to the real Yandex.
      fetch: this.clientOptions?.fetch ?? (process.env.NODE_ENV === 'test' ? blockedInTests : undefined),
      retryDelaysMs: this.clientOptions?.retryDelaysMs,
    });
    return this.lastClient;
  }

  get rateLimit() {
    return this.lastClient?.lastRateLimit ?? null;
  }

  /**
   * One run. Runs never overlap in this process: a poll or «Проверить сейчас» while another run is going returns
   * «уже идёт»; a notification waits in the queue and runs right after (it is never dropped).
   * orderIds: only these orders (notifications), without the date window.
   */
  async run(opts: { trigger: Trigger; staffId?: string | null; orderIds?: number[] }) {
    if (opts.trigger !== 'webhook' && this.active > 0) return { skipped: 'Синхронизация уже идёт — подождите' as const };
    this.active++;
    const job = this.queue.then(() => this.runNow(opts));
    this.queue = job.catch(() => undefined);
    try {
      return await job;
    } finally {
      this.active--;
    }
  }

  private async runNow(opts: { trigger: Trigger; staffId?: string | null; orderIds?: number[] }) {
    const cfg = this.cfg();
    const mode: Mode = cfg.dryRun ? 'DRY_RUN' : 'LIVE';
    const run = await this.prisma.yandex_sync_runs.create({ data: { trigger: opts.trigger, mode, started_by: opts.staffId ?? null } });
    const counters = { found: 0, created: 0, updated: 0, attention: 0, errors: 0 };
    const details: RunDetail[] = [];
    const raws: unknown[] = [];
    let error: string | null = null;
    let lateNew = 0;
    try {
      let rawOrders: unknown[];
      if (opts.orderIds?.length) {
        rawOrders = await this.client().businessOrders(cfg.businessId, { campaignIds: cfg.campaignIds, orderIds: opts.orderIds });
      } else {
        const first = (await this.prisma.yandex_sync_runs.count({ where: { mode, error: null, finished_at: { not: null }, id: { not: run.id } } })) === 0;
        const days = first ? cfg.firstDays : cfg.days;
        const from = new Date(Date.now() - days * 86_400_000).toISOString();
        rawOrders = await this.client().businessOrders(cfg.businessId, { campaignIds: cfg.campaignIds, updateDateFrom: from });
        // «Требует внимания: неизвестный SKU» (not closed, no order yet) is read again every run, even if Yandex did
        // not change it within the window: an alternative SKU added later lets the next poll create it.
        const seen = new Set(rawOrders.map((r) => String((r as { orderId?: unknown })?.orderId)));
        const waiting = await this.prisma.marketplace_external_orders.findMany({
          where: { attention_kind: 'UNKNOWN_SKU', closed_at: null, order_id: null },
          select: { external_number: true },
          take: 500,
        });
        const again = waiting.map((w) => Number(w.external_number)).filter((n) => Number.isInteger(n) && n > 0 && !seen.has(String(n)));
        for (let i = 0; i < again.length; i += 50) {
          rawOrders.push(...(await this.client().businessOrders(cfg.businessId, { campaignIds: cfg.campaignIds, orderIds: again.slice(i, i + 50) })));
        }
      }
      counters.found = rawOrders.length;
      for (const raw of rawOrders) {
        if (mode === 'DRY_RUN' && raws.length < 200) raws.push(minimizeYandexOrder(raw)); // no personal data in the log
        try {
          const r = mode === 'LIVE' ? await this.processLive(raw, cfg) : await this.processDry(raw, cfg);
          if (r.created) counters.created++;
          if (r.updated) counters.updated++;
          if (r.attention) counters.attention++;
          if (r.lateNew) lateNew++;
          if (details.length < MAX_DETAILS) details.push(r.detail);
        } catch (e) {
          counters.errors++;
          const msg = this.safe(e instanceof Error ? e.message : String(e));
          const number = (raw as { orderId?: unknown })?.orderId;
          if (details.length < MAX_DETAILS) details.push({ number: number === undefined ? null : String(number), action: 'error', reason: msg });
          if (mode === 'LIVE' && typeof number === 'number') {
            await this.prisma.marketplace_external_orders.updateMany({ where: { marketplace: 'yandex', external_number: String(number) }, data: { last_error: msg } }).catch(() => undefined);
          }
        }
      }
      if (mode === 'LIVE' && lateNew > 0) {
        await this.notifications.toStaffRoles(this.prisma, ['admin'], 'staff.yandex_late_summary', { order_number: '—', count: lateNew, admin_path: '/yandex-sync' });
      }
    } catch (e) {
      error = this.safe(e instanceof YandexApiError ? e.message : `Ошибка синхронизации: ${(e as Error).message}`);
      await this.errors.record({ level: 'error', service: 'yandex-sync', message: error, context: { job: 'yandex-sync', status: mode } }).catch(() => undefined);
    }
    return this.prisma.yandex_sync_runs.update({
      where: { id: run.id },
      data: { ...counters, finished_at: new Date(), error, details: { items: details, ...(mode === 'DRY_RUN' && { raw: raws }) } as unknown as Prisma.InputJsonObject },
    });
  }

  // ---------------------------------------------------------------- one order

  private campaignOk(cfg: YandexSyncConfig, campaignId: number | null) {
    return campaignId !== null && cfg.campaignIds.includes(campaignId);
  }

  /** DRY_RUN: the same decision as LIVE, nothing written. */
  private async processDry(raw: unknown, cfg: YandexSyncConfig): Promise<Outcome> {
    const parsed = parseYandexOrder(raw);
    const number = parsed.ok ? parsed.order.externalNumber : parsed.externalNumber;
    const campaign = parsed.ok ? parsed.order.campaignId : parsed.campaignId;
    if (!this.campaignOk(cfg, campaign)) return { detail: { number, action: 'skip', reason: `кампания ${campaign} не в списке` } };
    const ext = number ? await this.prisma.marketplace_external_orders.findUnique({ where: { marketplace_external_number: { marketplace: 'yandex', external_number: number } } }) : null;
    if (!parsed.ok) return { attention: true, detail: { number, action: 'would_attention', reason: `${ATTENTION_RU.BAD_DATA}: ${parsed.reason}` } };
    const plan = await this.plan(this.prisma, parsed.order, ext);
    const status = yandexStatusRu(parsed.order.status, parsed.order.substatus);
    switch (plan.type) {
      case 'skip':
        return { detail: { number, status, action: 'skip', reason: plan.reason } };
      case 'closed':
        return { detail: { number, status, action: 'skip', reason: 'закрыт как неактуальный' } };
      case 'create':
        return {
          created: true,
          detail: {
            number,
            status,
            action: plan.enough ? 'would_create' : 'would_create_without_units',
            reason: `${plan.lines.map((l) => `${l.sku} × ${l.qty}`).join(', ')}${plan.enough ? '' : ' — не хватает остатка, без резерва'}${aliasNote(plan.byAlias)}`,
          },
        };
      case 'attention':
        return { attention: true, detail: { number, status, action: 'would_attention', reason: `${ATTENTION_RU[plan.kind]}: ${plan.reason}` } };
      case 'sync':
        return {
          updated: !!plan.then,
          attention: !!plan.attention,
          detail: { number, status, action: plan.then === 'cancel' ? 'would_cancel' : plan.then === 'return' ? 'would_return' : plan.attention ? 'would_attention' : 'would_update_status', reason: plan.attention?.reason },
        };
    }
  }

  private async processLive(raw: unknown, cfg: YandexSyncConfig): Promise<Outcome> {
    const parsed = parseYandexOrder(raw);
    const number = parsed.ok ? parsed.order.externalNumber : parsed.externalNumber;
    const campaign = parsed.ok ? parsed.order.campaignId : parsed.campaignId;
    if (!this.campaignOk(cfg, campaign)) return { detail: { number, action: 'skip', reason: `кампания ${campaign} не в списке` } };
    if (!number) throw new Error(`Битый заказ без номера: ${parsed.ok ? '' : parsed.reason}`);

    const outcome = await this.prisma.$transaction(
      async (tx): Promise<Outcome> => {
        // One order at a time: a poll and a notification for the same number queue here.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`yandex-order:${number}`}))`;
        const json = minimizeYandexOrder(raw) as Prisma.InputJsonValue; // white list: no buyer, address, notes
        const order = parsed.ok ? parsed.order : null;
        const ext = await tx.marketplace_external_orders.upsert({
          where: { marketplace_external_number: { marketplace: 'yandex', external_number: number } },
          create: {
            marketplace: 'yandex',
            external_number: number,
            campaign_id: BigInt(campaign!),
            status: order?.status ?? 'UNKNOWN',
            substatus: order?.substatus ?? null,
            yandex_updated_at: order?.updatedAt ?? null,
            raw: json,
          },
          update: {
            raw: json,
            status: order?.status ?? 'UNKNOWN',
            substatus: order?.substatus ?? null,
            yandex_updated_at: order?.updatedAt ?? null,
            last_seen_at: new Date(),
            last_error: null,
          },
        });
        const statusText = order ? yandexStatusRu(order.status, order.substatus) : undefined;

        if (!parsed.ok) {
          await this.attention(tx, ext, 'BAD_DATA', parsed.reason);
          return { attention: true, detail: { number, action: 'attention', reason: `${ATTENTION_RU.BAD_DATA}: ${parsed.reason}` } };
        }
        const plan = await this.plan(tx, parsed.order, ext);
        switch (plan.type) {
          case 'skip':
            return { detail: { number, status: statusText, action: 'skip', reason: plan.reason } };
          case 'closed':
            return { detail: { number, status: statusText, action: 'skip', reason: 'закрыт как неактуальный' } };
          case 'attention': {
            const r = await this.attention(tx, ext, plan.kind, plan.reason);
            return { attention: true, lateNew: r.isNew && plan.kind === 'FIRST_SEEN_LATE', detail: { number, status: statusText, action: 'attention', reason: `${ATTENTION_RU[plan.kind]}: ${plan.reason}` } };
          }
          case 'create': {
            const created = await this.orders.createInTx(
              tx,
              null,
              { external_number: number, order_date: parsed.order.orderDate, lines: plan.lines.map(({ product_id, qty, unit_price_uzs }) => ({ product_id, qty, unit_price_uzs })) },
              { source: 'yandex_api', onShortage: 'flag', yandex: { status: parsed.order.status, substatus: parsed.order.substatus, campaignId: BigInt(parsed.order.campaignId), updatedAt: parsed.order.updatedAt } },
            );
            await tx.marketplace_external_orders.update({
              where: { id: ext.id },
              data: { order_id: created.id, attention_kind: null, attention_reason: null, attention_at: null, new_order_notified_at: ext.new_order_notified_at ?? new Date() },
            });
            const items = plan.lines.map((l) => `${l.sku} × ${l.qty}`).join(', ');
            if (created.shortage) await this.attention(tx, { ...ext, order_id: created.id }, 'NOT_ENOUGH_STOCK', created.shortage);
            if (!ext.new_order_notified_at) {
              // in the same transaction: the message is queued only if the order really exists (outbox)
              await this.notifications.toStaffRoles(tx, ['warehouse', 'admin'], 'staff.yandex_new_order', {
                order_number: number,
                items,
                shortage: !!created.shortage,
                admin_path: `/yandex-orders/${created.id}`,
              });
            }
            return {
              created: true,
              attention: !!created.shortage,
              detail: { number, status: statusText, action: created.shortage ? 'created_without_units' : 'created', reason: `${items}${created.shortage ? ` — ${created.shortage}` : ` — банки: ${created.reserved.join(', ')}`}${aliasNote(plan.byAlias)}` },
            };
          }
          case 'sync': {
            const ours = await this.orders.lock(tx, plan.orderId);
            const changed = ours.yandex_status !== parsed.order.status || ours.yandex_substatus !== parsed.order.substatus;
            await tx.marketplace_orders.update({
              where: { id: ours.id },
              data: { yandex_status: parsed.order.status, yandex_substatus: parsed.order.substatus, yandex_campaign_id: BigInt(parsed.order.campaignId), yandex_updated_at: parsed.order.updatedAt },
            });
            if (!ext.order_id) await tx.marketplace_external_orders.update({ where: { id: ext.id }, data: { order_id: ours.id } });
            let action = changed ? 'status_updated' : 'unchanged';
            let ourStatus: MarketplaceOrderStatus | null = null;
            if (plan.then) {
              const reason = `Отменён в Яндексе${parsed.order.substatus ? ` (${parsed.order.substatus})` : ''}`;
              ourStatus = (await this.orders.cancelInTx(tx, ours, null, reason)).status;
              action = ourStatus === 'CANCELLED' ? 'cancelled' : 'returned';
            }
            let attention = false;
            if (plan.attention && !ext.closed_at) {
              await this.attention(tx, ext, plan.attention.kind, plan.attention.reason);
              attention = true;
            }
            return { updated: changed || !!plan.then, attention, detail: { number, status: statusText, action, reason: plan.attention?.reason } };
          }
        }
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    return outcome;
  }

  /**
   * The decision for one parsed order (read only: the same for DRY_RUN and LIVE).
   * Our order exists → keep the Yandex status; a Yandex cancellation cancels it (2C rules); a Yandex return →
   * attention. No order → create from PROCESSING; wait for not confirmed; anything else → attention.
   */
  private async plan(db: Db, o: ParsedYandexOrder, ext: { order_id: string | null; closed_at: Date | null } | null): Promise<Plan> {
    const ours = ext?.order_id
      ? await db.marketplace_orders.findUnique({ where: { id: ext.order_id } })
      : await db.marketplace_orders.findUnique({ where: { marketplace_external_number: { marketplace: 'yandex', external_number: o.externalNumber } } });
    if (ours) {
      const closed = ours.status === 'CANCELLED' || ours.status === 'RETURNED';
      if (o.status === 'CANCELLED' && !closed) {
        return { type: 'sync', orderId: ours.id, then: ours.status === 'NEW' || ours.status === 'ASSEMBLED' ? 'cancel' : 'return' };
      }
      if (RETURN_STATUSES.includes(o.status) && !closed) {
        return { type: 'sync', orderId: ours.id, then: null, attention: { kind: 'RETURN', reason: `${yandexStatusRu(o.status)} — проверьте, какие банки вернулись, и оформите возврат в карточке` } };
      }
      return { type: 'sync', orderId: ours.id, then: null };
    }
    if (ext?.closed_at) return { type: 'closed' };
    if (WAIT_STATUSES.includes(o.status)) return { type: 'skip', reason: `ещё не подтверждён (${o.status}) — ждём` };
    if (LATE_STATUSES.includes(o.status)) {
      return { type: 'attention', kind: 'FIRST_SEEN_LATE', reason: `впервые увиден в статусе «${yandexStatusRu(o.status, o.substatus)}»; банки автоматически не резервируются` };
    }
    if (o.status !== CREATE_STATUS) return { type: 'attention', kind: 'UNKNOWN_STATUS', reason: `статус ${o.status} не в таблице соответствия` };

    // the SKU itself first, then an alternative SKU (old code)
    const skus = [...new Set(o.items.map((i) => i.offerId))];
    const found = await findProductsBySkus(db, skus);
    const unknown = skus.filter((s) => !found.has(s));
    if (unknown.length) return { type: 'attention', kind: 'UNKNOWN_SKU', reason: `нет товара с SKU ${unknown.join(', ')} (ни по SKU, ни по альтернативному SKU)` };
    const products = [...new Map([...found.values()].map((p) => [p.id, p])).values()];
    const byOffer = (offerId: string) => found.get(offerId)!;
    const byAlias = skus.filter((s) => found.get(s)!.alias).map((s) => `${s} → ${found.get(s)!.sku}`);
    const untracked = products.filter((p) => !p.unit_tracking).map((p) => p.sku);
    if (untracked.length) return { type: 'attention', kind: 'NOT_UNIT_TRACKED', reason: `${untracked.join(', ')} не учитывается по банкам` };
    const foreign = o.items.filter((i) => i.currency && i.currency !== 'UZS');
    if (foreign.length) return { type: 'attention', kind: 'CURRENCY', reason: `цена в ${foreign[0].currency}, ожидаются сумы (UZS)` };
    const noPrice = o.items.filter((i) => i.unitPrice === null && byOffer(i.offerId).yandex_price_uzs === null);
    if (noPrice.length) return { type: 'attention', kind: 'BAD_DATA', reason: `нет цены у ${noPrice.map((i) => i.offerId).join(', ')} ни в заказе, ни в карточке товара` };

    const lines = o.items.map((i) => {
      const p = byOffer(i.offerId);
      return { product_id: p.id, sku: p.sku, qty: i.count, ...(i.unitPrice !== null && { unit_price_uzs: i.unitPrice }) };
    });
    // enough: only for the DRY_RUN text; LIVE decides under locks in createInTx
    let enough = true;
    for (const [productId, n] of countBy(lines.map((l) => [l.product_id, l.qty] as const))) {
      const inv = await db.inventory.findMany({ where: { product_id: productId }, select: { actual_qty: true, reserved_qty: true } });
      const available = inv.reduce((m, r) => Math.max(m, r.actual_qty - r.reserved_qty), 0);
      const free = await db.physical_units.count({ where: { product_id: productId, status: 'IN_STOCK', marketplace_units: { none: { released_at: null } } } });
      if (available < n || free < n) enough = false;
    }
    return { type: 'create', lines, enough, byAlias };
  }

  /**
   * «Требует внимания»: set (or keep) the kind and the reason. A message to the admin once per kind (a repeated poll
   * never sends it again); FIRST_SEEN_LATE goes into one summary per run instead. A closed entry stays closed.
   */
  private async attention(tx: Tx, ext: { id: string; external_number: string; order_id: string | null; attention_kind: string | null; attention_notified_at: Date | null; closed_at: Date | null }, kind: AttentionKind, reason: string) {
    if (ext.closed_at) return { isNew: false };
    const isNew = ext.attention_kind !== kind;
    const sendNow = kind !== 'FIRST_SEEN_LATE' && (isNew || !ext.attention_notified_at);
    await tx.marketplace_external_orders.update({
      where: { id: ext.id },
      data: {
        attention_kind: kind,
        attention_reason: reason,
        ...(isNew && { attention_at: new Date() }),
        ...(sendNow ? { attention_notified_at: new Date() } : isNew ? { attention_notified_at: null } : {}),
      },
    });
    if (sendNow) {
      await this.notifications.toStaffRoles(tx, ['admin'], 'staff.yandex_attention', {
        order_number: ext.external_number,
        reason: `${ATTENTION_RU[kind]} — ${reason}`,
        admin_path: ext.order_id ? `/yandex-orders/${ext.order_id}` : '/yandex-sync',
      });
    }
    return { isNew };
  }

  // ---------------------------------------------------------------- admin screen

  async status() {
    const cfg = this.cfg();
    const [runs, attention] = await Promise.all([
      this.prisma.yandex_sync_runs.findMany({ orderBy: { started_at: 'desc' }, take: 20, omit: { details: true } }),
      this.attentionList(),
    ]);
    return { config: cfg, running: this.active > 0, rate_limit: this.rateLimit, runs, attention };
  }

  attentionList() {
    return this.prisma.marketplace_external_orders
      .findMany({
        where: { attention_kind: { not: null }, closed_at: null },
        orderBy: { attention_at: 'desc' },
        take: 500,
        select: { id: true, external_number: true, status: true, substatus: true, attention_kind: true, attention_reason: true, attention_at: true, order_id: true, last_error: true, first_seen_at: true },
      })
      .then((rows) => rows.map((r) => ({ ...r, kind_ru: ATTENTION_RU[r.attention_kind as AttentionKind] ?? r.attention_kind, status_ru: yandexStatusRu(r.status, r.substatus) })));
  }

  async runDetails(id: string) {
    const run = await this.prisma.yandex_sync_runs.findUnique({ where: { id } });
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Запуск не найден' });
    return run;
  }

  async external(id: string) {
    const row = await this.prisma.marketplace_external_orders.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ Яндекса не найден' });
    return { ...row, campaign_id: Number(row.campaign_id) };
  }

  /**
   * «Закрыть как неактуальный» (admin, reason, audit; S2D-Д): the entry leaves «Требует внимания» for good — later
   * polls do not raise it again and send no messages. If it is linked to our order, the Yandex status is still kept
   * up to date (and a Yandex cancellation still cancels it), only no new attention for it.
   */
  async close(staffId: string, id: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const [row] = await this.lockExternal(tx, [id]);
      if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Заказ Яндекса не найден' });
      if (row.closed_at) throw new ConflictException({ code: 'ALREADY_CLOSED', message: 'Уже закрыт' });
      await this.closeInTx(tx, staffId, row, reason);
      return { id, closed: true };
    });
  }

  /**
   * «Закрыть выбранные как неактуальные» (admin): up to 100 entries, ONE transaction — all of them are closed or none.
   * Every entry is closed by the same closeInTx as a single one (one audit row each, the shared reason).
   * Already closed → skipped (no error, the request can be repeated). Refused, and then nothing is closed: an entry
   * that already became our Yandex order (it may hold units), one that is not in «Требует внимания», an unknown id.
   */
  async closeMany(staffId: string, ids: string[], reason: string) {
    const unique = [...new Set(ids)];
    return this.prisma.$transaction(async (tx) => {
      const rows = await this.lockExternal(tx, unique);
      const rejected: { id: string; external_number: string | null; reason: string }[] = [];
      for (const id of unique.filter((x) => !rows.some((r) => r.id === x))) rejected.push({ id, external_number: null, reason: 'не найден' });
      const open = rows.filter((r) => !r.closed_at);
      for (const r of open) {
        if (r.order_id) {
          const units = await tx.marketplace_order_units.count({ where: { order_id: r.order_id, released_at: null } });
          rejected.push({ id: r.id, external_number: r.external_number, reason: units ? `есть резерв банок (${units}) — заказ уже создан, решайте в его карточке` : 'уже превращён в заказ Яндекса — решайте в его карточке' });
        } else if (!r.attention_kind) {
          rejected.push({ id: r.id, external_number: r.external_number, reason: 'не в «Требует внимания»' });
        }
      }
      if (rejected.length) {
        throw new ConflictException({
          code: 'BATCH_REJECTED',
          message: `Ничего не закрыто: ${rejected.length} из ${unique.length} нельзя закрыть массово — снимите с них отметку`,
          rejected,
        });
      }
      for (const r of open) await this.closeInTx(tx, staffId, r, reason);
      return { closed: open.length, skipped: rows.length - open.length, ids: open.map((r) => r.id) };
    });
  }

  /** The entries locked FOR UPDATE (in id order): a poll processing the same order waits for the close. */
  private lockExternal(tx: Tx, ids: string[]) {
    if (!ids.length) return Promise.resolve([]);
    return tx.$queryRaw<{ id: string; external_number: string; order_id: string | null; attention_kind: string | null; attention_reason: string | null; closed_at: Date | null }[]>`
      SELECT id, external_number, order_id, attention_kind, attention_reason, closed_at FROM marketplace_external_orders
      WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
  }

  /** The close itself (single and batch): closed for good + one audit row. */
  private async closeInTx(tx: Tx, staffId: string, row: { id: string; external_number: string; attention_kind: string | null; attention_reason: string | null }, reason: string) {
    await tx.marketplace_external_orders.update({ where: { id: row.id }, data: { closed_at: new Date(), closed_by: staffId, close_reason: reason } });
    await this.audit.log(
      { staffId, action: 'yandex_sync.closed', entityType: 'marketplace_external_order', entityId: row.id, before: { attention_kind: row.attention_kind, attention_reason: row.attention_reason }, after: { external_number: row.external_number, reason } },
      tx,
    );
  }

  /** Error texts never carry the token or the webhook secret (order numbers stay readable). */
  private safe(text: string): string {
    return scrubSecrets(text, [this.config.get<string>('YANDEX_API_KEY'), this.config.get<string>('YANDEX_WEBHOOK_SECRET')]);
  }
}

interface Outcome {
  detail: RunDetail;
  created?: boolean;
  updated?: boolean;
  attention?: boolean;
  lateNew?: boolean;
}

/** «найден по старому SKU» in the run log */
const aliasNote = (byAlias: string[]) => (byAlias.length ? ` — найден по старому SKU: ${byAlias.join(', ')}` : '');

const countBy = (pairs: (readonly [string, number])[]) => {
  const m = new Map<string, number>();
  for (const [k, n] of pairs) m.set(k, (m.get(k) ?? 0) + n);
  return [...m.entries()];
};

const blockedInTests: FetchLike = async () => {
  throw new Error('Real requests to Yandex are disabled in tests: inject a fake fetch (YANDEX_CLIENT_OPTIONS)');
};

/** Cuts the given secrets, Yandex API keys (ACMA:…) and Telegram bot tokens out of a text. */
export function scrubSecrets(text: string, secrets: (string | undefined)[]): string {
  let s = text;
  for (const secret of secrets) if (secret && secret.length >= 8) s = s.split(secret).join('[скрыто]');
  return s.replace(/ACMA:[A-Za-z0-9:_-]+/g, '[скрыто]').replace(/\d{6,12}:[A-Za-z0-9_-]{30,}/g, '[скрыто]').slice(0, 1000);
}
