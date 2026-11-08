import { BadRequestException, Body, Controller, Get, Injectable, Logger, Param, ParseUUIDPipe, Post, Put, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { IsBoolean } from 'class-validator';
import { memoryStorage } from 'multer';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { purchaseCosts } from '../promo/purchase-costs';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../staff/audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from '../staff/staff-auth';
import { latestPerPlatform, matchedCompetitors } from './competitors';
import { autoPrice, SKIP_LABELS, type AutoPriceResult } from './auto-price';
import { parseWishlist, type WishlistItem } from './wishlist-parser';

type Db = Prisma.TransactionClient | PrismaService;

/** The saved wishlist page with pictures inlined can be big; the text itself is a few hundred KB. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
/** «Настройки» key: Telegram reminders to admins at 09:00 / 15:00 / 21:00 Tashkent (off until the owner switches them on). */
export const IHERB_SETTINGS_KEY = 'iherb_prices';
export interface IherbSettings {
  reminders: boolean;
}
const SETTINGS_DEFAULT: IherbSettings = { reminders: false };
/** Tashkent hours of the three daily snapshots (D-57). */
export const SNAPSHOT_HOURS = [9, 15, 21] as const;
const TASHKENT_MS = 5 * 3600_000;
/** The market minimum in the list counts competitor prices seen in the last 60 days. */
const MARKET_DAYS = 60;

/**
 * The reminder slot `now` belongs to: the last 09:00 / 15:00 / 21:00 Tashkent not more than 2 hours ago (UTC Date), or null.
 * Two hours of slack: the laptop / server may be busy or restarting at the very minute.
 */
export function reminderSlot(now: Date): Date | null {
  const t = new Date(now.getTime() + TASHKENT_MS);
  for (const h of [...SNAPSHOT_HOURS].reverse()) {
    const slot = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), h) - TASHKENT_MS;
    const ago = now.getTime() - slot;
    if (ago >= 0 && ago < 2 * 3600_000) return new Date(slot);
  }
  return null;
}

export interface PreviewRow extends WishlistItem {
  product: { id: string; sku: string; name_ru: string; price_uzs: number; status: string } | null;
  /** The previous iHerb price of this product (any upload), to catch a misread price before saving. */
  last_price_uzs: number | null;
  change_pct: number | null;
  /** null: no VITALO product / auto price is off / the product is archived. */
  auto: (AutoPriceResult & { skip_label: string | null }) | null;
}

export class IherbSettingsInput {
  @ApiProperty({ description: 'Напоминать администраторам в Telegram в 09:00, 15:00 и 21:00 (Ташкент)' }) @IsBoolean() reminders!: boolean;
}

const num = (v: bigint | null | undefined) => (v == null ? null : Number(v));

@Injectable()
export class IherbPricesService {
  private readonly logger = new Logger(IherbPricesService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The text the owner gave: a file (saved page / .txt / .csv) or pasted text. */
  static inputOf(file: Express.Multer.File | undefined, text: unknown): string {
    const s = file ? file.buffer.toString('utf8') : typeof text === 'string' ? text : '';
    if (!s.trim()) throw new BadRequestException({ code: 'WISHLIST_EMPTY', message: 'Вставьте таблицу или выберите сохранённую страницу вишлиста' });
    return s;
  }

  /** Reads the wishlist and shows what would happen (nothing is written). */
  async preview(input: string) {
    return this.compute(this.prisma, input);
  }

  /** Reads the wishlist again (never trusts a preview from the browser), saves the snapshot and applies the auto prices. */
  async save(staffId: string, input: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const res = await this.compute(tx, input);
        const upload = await tx.iherb_uploads.create({
          data: { staff_user_id: staffId, items_total: res.items.length, items_matched: res.summary.matched, prices_changed: res.summary.will_change },
        });
        await tx.iherb_price_snapshots.createMany({
          data: res.items.map((r) => ({
            upload_id: upload.id,
            product_id: r.product?.id ?? null,
            iherb_product_id: r.iherb_product_id,
            title: r.title,
            price_uzs: BigInt(r.price_uzs),
            list_price_uzs: r.list_price_uzs == null ? null : BigInt(r.list_price_uzs),
            in_stock: r.in_stock,
            bestseller: r.bestseller,
            weight_kg: r.weight_kg,
            taken_at: upload.created_at,
          })),
        });
        for (const r of res.items) {
          if (!r.product || !r.auto?.apply) continue;
          const p = await tx.products.findUniqueOrThrow({ where: { id: r.product.id }, select: { price_uzs: true, old_price_uzs: true, yandex_price_uzs: true, markup_percent: true } });
          const next = BigInt(r.auto.target_uzs);
          // a crossed-out price lower than the new price would read as a price rise: it goes away
          const old = p.old_price_uzs != null && p.old_price_uzs <= next ? null : p.old_price_uzs;
          await tx.products.update({ where: { id: r.product.id }, data: { price_uzs: next, old_price_uzs: old } });
          await tx.price_changes.create({
            data: {
              product_id: r.product.id,
              upload_id: upload.id,
              staff_user_id: staffId,
              reason: 'iherb_auto',
              status: 'applied',
              old_price_uzs: p.price_uzs,
              new_price_uzs: next,
              iherb_price_uzs: BigInt(r.price_uzs),
              markup_percent: p.markup_percent,
              floor_applied: r.auto.floor_applied,
              big_jump: r.auto.big_jump,
              yandex_check: p.yandex_price_uzs != null,
            },
          });
          await this.audit.log(
            {
              staffId,
              action: 'product.price_auto_iherb',
              entityType: 'product',
              entityId: r.product.id,
              before: { price_uzs: p.price_uzs, old_price_uzs: p.old_price_uzs },
              after: { price_uzs: next, old_price_uzs: old, iherb_price_uzs: r.price_uzs, markup_percent: p.markup_percent, floor_applied: r.auto.floor_applied, big_jump: r.auto.big_jump },
            },
            tx,
          );
        }
        await this.audit.log({ staffId, action: 'iherb.wishlist_uploaded', entityType: 'iherb_upload', entityId: upload.id, after: { ...res.summary, format: res.format } }, tx);
        return { upload_id: upload.id, ...res };
      },
      { timeout: 60_000 },
    );
  }

  private async compute(db: Db, input: string) {
    const parsed = parseWishlist(input);
    if (parsed.wrong_currency) {
      throw new BadRequestException({ code: 'WISHLIST_CURRENCY', message: 'На странице цены не в сумах. Переключите валюту на iHerb на «UZS — сум» и сохраните страницу заново.' });
    }
    if (!parsed.items.length) {
      throw new BadRequestException({ code: 'WISHLIST_NOTHING', message: 'Не найдено ни одного товара с ценой в сумах', problems: parsed.problems.slice(0, 20) });
    }
    const ids = parsed.items.map((i) => i.iherb_product_id);
    const [products, lasts, guard] = await Promise.all([
      db.products.findMany({
        where: { iherb_product_id: { in: ids } },
        select: {
          id: true,
          sku: true,
          name_ru: true,
          status: true,
          price_uzs: true,
          iherb_product_id: true,
          auto_pricing_enabled: true,
          markup_percent: true,
          price_round_to: true,
          stock_price_mode: true,
          inventory: { select: { actual_qty: true, reserved_qty: true } },
        },
      }),
      db.iherb_price_snapshots.findMany({ where: { iherb_product_id: { in: ids } }, orderBy: [{ iherb_product_id: 'asc' }, { taken_at: 'desc' }], distinct: ['iherb_product_id'], select: { iherb_product_id: true, price_uzs: true } }),
      this.settings.getOrDefault('promo_guard'),
    ]);
    const costs = await purchaseCosts(db, products.map((p) => p.id));
    const items: PreviewRow[] = parsed.items.map((i) => {
      const p = products.find((x) => x.iherb_product_id === i.iherb_product_id);
      const last = num(lasts.find((l) => l.iherb_product_id === i.iherb_product_id)?.price_uzs);
      let auto: PreviewRow['auto'] = null;
      if (p && p.auto_pricing_enabled && p.status !== 'archived') {
        const r = autoPrice({
          iherb_price_uzs: i.price_uzs,
          iherb_in_stock: i.in_stock,
          markup_percent: p.markup_percent,
          price_round_to: p.price_round_to,
          stock_price_mode: p.stock_price_mode,
          available: p.inventory.reduce((s, v) => s + v.actual_qty - v.reserved_qty, 0),
          current_price_uzs: Number(p.price_uzs),
          cost_uzs: costs.get(p.id) ?? null,
          min_markup_pct: guard.min_markup_pct,
        });
        auto = { ...r, skip_label: r.skip_reason ? SKIP_LABELS[r.skip_reason] : null };
      }
      return {
        ...i,
        product: p ? { id: p.id, sku: p.sku, name_ru: p.name_ru, price_uzs: Number(p.price_uzs), status: p.status } : null,
        last_price_uzs: last,
        change_pct: last ? Math.round(((i.price_uzs - last) * 1000) / last) / 10 : null,
        auto,
      };
    });
    const matched = items.filter((r) => r.product).length;
    return {
      format: parsed.format,
      items,
      problems: parsed.problems,
      summary: {
        total: items.length,
        matched,
        unknown: items.length - matched,
        will_change: items.filter((r) => r.auto?.apply).length,
        big_jumps: items.filter((r) => r.auto?.apply && r.auto.big_jump).length,
      },
    };
  }

  /** «iHerb и цены»: every product with an iHerb link, its last iHerb price and the last auto change. */
  async products() {
    const list = await this.prisma.products.findMany({
      where: { iherb_product_id: { not: null }, status: { not: 'archived' } },
      orderBy: { name_ru: 'asc' },
      select: {
        id: true,
        sku: true,
        name_ru: true,
        status: true,
        price_uzs: true,
        iherb_url: true,
        iherb_product_id: true,
        auto_pricing_enabled: true,
        markup_percent: true,
        price_round_to: true,
        stock_price_mode: true,
        inventory: { select: { actual_qty: true, reserved_qty: true } },
      },
    });
    const ids = list.map((p) => p.iherb_product_id!);
    const [lasts, changes, costs, market] = await Promise.all([
      this.prisma.iherb_price_snapshots.findMany({ where: { iherb_product_id: { in: ids } }, orderBy: [{ iherb_product_id: 'asc' }, { taken_at: 'desc' }], distinct: ['iherb_product_id'] }),
      this.prisma.price_changes.findMany({ where: { product_id: { in: list.map((p) => p.id) } }, orderBy: [{ product_id: 'asc' }, { created_at: 'desc' }], distinct: ['product_id'] }),
      purchaseCosts(this.prisma, list.map((p) => p.id)),
      matchedCompetitors(this.prisma, list.map((p) => p.id), MARKET_DAYS),
    ]);
    return list.map(({ inventory, ...p }) => {
      const comp = market.get(p.id) ?? [];
      const s = lasts.find((l) => l.iherb_product_id === p.iherb_product_id);
      const c = changes.find((x) => x.product_id === p.id);
      return {
        ...p,
        price_uzs: Number(p.price_uzs),
        available: inventory.reduce((n, v) => n + v.actual_qty - v.reserved_qty, 0),
        cost_uzs: costs.get(p.id) ?? null,
        // D-57 узел 4: the lowest «1-в-1» competitor price of the last 60 days, and how many prices there are
        market_min_uzs: comp.length ? Math.min(...comp.map((c) => c.price_uzs)) : null,
        competitors_count: comp.length,
        last_snapshot: s ? { price_uzs: Number(s.price_uzs), in_stock: s.in_stock, bestseller: s.bestseller, taken_at: s.taken_at } : null,
        last_change: c ? { old_price_uzs: Number(c.old_price_uzs), new_price_uzs: Number(c.new_price_uzs), big_jump: c.big_jump, floor_applied: c.floor_applied, yandex_check: c.yandex_check, created_at: c.created_at } : null,
      };
    });
  }

  /** Chart data of one product: iHerb prices and VITALO price changes for the last `days` days. */
  async history(productId: string, days: number) {
    const p = await this.prisma.products.findUnique({ where: { id: productId }, select: { id: true, sku: true, name_ru: true, price_uzs: true, iherb_product_id: true, markup_percent: true } });
    if (!p) throw new BadRequestException({ code: 'PRODUCT_NOT_FOUND', message: 'Товар не найден' });
    const since = new Date(Date.now() - days * 86400_000);
    const [snapshots, changes, costs, market] = await Promise.all([
      p.iherb_product_id
        ? this.prisma.iherb_price_snapshots.findMany({ where: { iherb_product_id: p.iherb_product_id, taken_at: { gte: since } }, orderBy: { taken_at: 'asc' }, take: 2000 })
        : [],
      this.prisma.price_changes.findMany({ where: { product_id: p.id, created_at: { gte: since } }, orderBy: { created_at: 'asc' }, take: 2000 }),
      purchaseCosts(this.prisma, [p.id]),
      matchedCompetitors(this.prisma, [p.id], days),
    ]);
    const comp = market.get(p.id) ?? [];
    return {
      /** «1-в-1» competitor prices in the period (chart points) and the newest per platform (bars) */
      competitors: comp.map((c) => ({ observed_on: c.observed_on, platform: c.platform, seller: c.seller, price_uzs: c.price_uzs })),
      competitors_latest: latestPerPlatform(comp).map((c) => ({ observed_on: c.observed_on, platform: c.platform, seller: c.seller, price_uzs: c.price_uzs })),
      product: { ...p, price_uzs: Number(p.price_uzs), cost_uzs: costs.get(p.id) ?? null },
      snapshots: snapshots.map((s) => ({ taken_at: s.taken_at, price_uzs: Number(s.price_uzs), list_price_uzs: num(s.list_price_uzs), in_stock: s.in_stock, bestseller: s.bestseller })),
      changes: changes.map((c) => ({
        created_at: c.created_at,
        old_price_uzs: Number(c.old_price_uzs),
        new_price_uzs: Number(c.new_price_uzs),
        iherb_price_uzs: num(c.iherb_price_uzs),
        markup_percent: c.markup_percent,
        big_jump: c.big_jump,
        floor_applied: c.floor_applied,
        yandex_check: c.yandex_check,
      })),
    };
  }

  async uploads() {
    const rows = await this.prisma.iherb_uploads.findMany({ orderBy: { created_at: 'desc' }, take: 30, include: { staff: { select: { name: true } } } });
    return rows.map(({ staff, ...u }) => ({ ...u, staff_name: staff?.name ?? null }));
  }

  async getSettings(): Promise<IherbSettings> {
    return { ...SETTINGS_DEFAULT, ...((await this.settings.get<IherbSettings>(IHERB_SETTINGS_KEY)) ?? {}) };
  }

  async setSettings(staffId: string, value: IherbSettings): Promise<IherbSettings> {
    const before = await this.getSettings();
    const json = { reminders: value.reminders } as unknown as Prisma.InputJsonValue;
    await this.prisma.$transaction(async (tx) => {
      await tx.settings.upsert({ where: { key: IHERB_SETTINGS_KEY }, create: { key: IHERB_SETTINGS_KEY, value: json }, update: { value: json } });
      await this.audit.log({ staffId, action: 'settings.iherb_prices_updated', entityType: 'settings', before, after: value }, tx);
    });
    return this.getSettings();
  }

  @Interval('iherb-reminders', 5 * 60_000)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      if (await this.remindOnce()) this.logger.log('iHerb wishlist reminder queued');
    } catch (e) {
      this.logger.error('iHerb reminders failed', e as Error);
    } finally {
      this.running = false;
    }
  }

  /**
   * At 09:00 / 15:00 / 21:00 Tashkent: «Пора загрузить вишлист iHerb» to admins — only when switched on, when some
   * product has an iHerb link and nobody uploaded since an hour before the slot. Once per slot (iherb_reminders row).
   */
  async remindOnce(now = new Date()): Promise<boolean> {
    const slot = reminderSlot(now);
    if (!slot || !(await this.getSettings()).reminders) return false;
    if (await this.prisma.iherb_reminders.findUnique({ where: { slot } })) return false;
    const linked = await this.prisma.products.count({ where: { iherb_product_id: { not: null }, status: { not: 'archived' } } });
    if (!linked) return false;
    const fresh = await this.prisma.iherb_uploads.count({ where: { created_at: { gte: new Date(slot.getTime() - 3600_000) } } });
    if (fresh) return false;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.iherb_reminders.create({ data: { slot } });
        await this.notifications.toStaffRoles(tx, ['admin'], 'staff.iherb_upload_due', { order_number: '', count: linked, admin_path: '/iherb' });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false; // another process was first
      throw e;
    }
    return true;
  }
}

/** «iHerb и цены» (admin only: margins and purchase costs are visible). */
@ApiTags('staff: iherb')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/iherb')
export class IherbPricesController {
  constructor(private readonly iherb: IherbPricesService) {}

  @Post('uploads')
  @RequirePermission('iherb.prices')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, text: { type: 'string' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, fieldSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(@CurrentStaff() me: StaffContext, @Query('dry_run') dryRun: string | undefined, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: { text?: unknown }) {
    const input = IherbPricesService.inputOf(file, body?.text);
    return dryRun === '1' || dryRun === 'true' ? this.iherb.preview(input) : this.iherb.save(me.staff.id, input);
  }

  @Get('uploads')
  @RequirePermission('iherb.prices')
  uploads() {
    return this.iherb.uploads();
  }

  @Get('products')
  @RequirePermission('iherb.prices')
  products() {
    return this.iherb.products();
  }

  @Get('products/:id/history')
  @RequirePermission('iherb.prices')
  history(@Param('id', new ParseUUIDPipe()) id: string, @Query('days') days?: string) {
    const d = Math.min(365, Math.max(1, Number(days) || 90));
    return this.iherb.history(id, d);
  }

  @Get('settings')
  @RequirePermission('iherb.prices')
  getSettings() {
    return this.iherb.getSettings();
  }

  @Put('settings')
  @RequirePermission('iherb.prices')
  setSettings(@CurrentStaff() me: StaffContext, @Body() dto: IherbSettingsInput) {
    return this.iherb.setSettings(me.staff.id, dto);
  }
}
