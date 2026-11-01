import { Controller, Get, Injectable, Logger, NotFoundException, Param } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { listInclude, ProductListItem, ShopCampaign, toProductListItem } from '../catalog/product.mapper';
import { tashkentDateTime } from '../common/tashkent';
import { quietUntil } from '../notifications/notification-worker';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { CampaignSkinCode, effectivePrice } from './campaigns';
import { LineCampaign } from './promo.service';
import { purchaseCosts } from './purchase-costs';

type Db = Prisma.TransactionClient | PrismaService;

/** A product in a running sale: its regular price, the price the shop charges now and the sale. */
export interface ProductCampaign {
  product_id: string;
  list_price_uzs: number;
  price_uzs: number;
  discount_pct: number;
  campaign: { id: string; slug: string; skin: CampaignSkinCode; title_ru: string; title_uz: string | null; ends_at: Date | null };
}

/** The home slide and the sale page. */
export interface ShopCampaignSummary {
  id: string;
  slug: string;
  skin: CampaignSkinCode;
  title_ru: string;
  title_uz: string | null;
  ends_at: Date | null;
  max_discount_pct: number;
  products_count: number;
}

const RUNNING = (now: Date) => ({ kind: 'campaign' as const, status: 'active' as const, start_at: { lte: now }, end_at: { gt: now } });

export function toShopCampaign(c: ProductCampaign): ShopCampaign {
  return { ...c.campaign, discount_pct: c.discount_pct, list_price_uzs: c.list_price_uzs };
}

export function toLineCampaign(c: ProductCampaign): LineCampaign {
  return { id: c.campaign.id, title_ru: c.campaign.title_ru, title_uz: c.campaign.title_uz, skin: c.campaign.skin, discount_pct: c.discount_pct };
}

const goodsWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'товар' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'товара' : 'товаров');

/** «Акция «11.11» началась» — the message about the start (centre to everybody, bot to «Получать акции и новости»). */
export function startMessage(s: Pick<ShopCampaignSummary, 'title_ru' | 'title_uz' | 'ends_at' | 'max_discount_pct' | 'products_count'>) {
  const until = s.ends_at ? tashkentDateTime(s.ends_at) : null;
  return {
    title_ru: `Акция «${s.title_ru}» началась`,
    text_ru: `Скидки до ${s.max_discount_pct}% на ${s.products_count} ${goodsWord(s.products_count)}${until ? ` — до ${until}` : ''}.`,
    title_uz: `«${s.title_uz || s.title_ru}» aksiyasi boshlandi`,
    text_uz: `${s.products_count} ta mahsulotga ${s.max_discount_pct}% gacha chegirma${until ? ` — ${until} gacha` : ''}.`,
  };
}

/**
 * 3.7: sales («Акции») in the shop. A sale runs by the clock (switched on, start ≤ now < end): nothing switches prices,
 * products.price_uzs stays the regular price and comes back by itself when the sale is over.
 * One product is in one running sale (the form does not allow two); if two ever overlap, the one that started first wins.
 */
@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);
  private notifying = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async running(db: Db, productIds: string[], now = new Date()): Promise<Map<string, ProductCampaign>> {
    const out = new Map<string, ProductCampaign>();
    const ids = [...new Set(productIds)];
    if (!ids.length) return out;
    const rows = await db.promotion_targets.findMany({
      where: { product_id: { in: ids }, promotion: RUNNING(now) },
      select: {
        product_id: true,
        discount_pct: true,
        campaign_price_uzs: true,
        product: { select: { price_uzs: true } },
        promotion: { select: { id: true, slug: true, skin: true, title_ru: true, title_uz: true, name: true, start_at: true, end_at: true, open_ended: true, created_at: true } },
      },
    });
    if (!rows.length) return out;
    rows.sort((a, b) => a.promotion.start_at.getTime() - b.promotion.start_at.getTime() || a.promotion.created_at.getTime() - b.promotion.created_at.getTime());
    const [costs, guard] = await Promise.all([purchaseCosts(db, rows.map((r) => r.product_id!)), this.settings.getOrDefault('promo_guard')]);
    for (const r of rows) {
      const id = r.product_id!;
      if (out.has(id) || !r.product) continue;
      const list = Number(r.product.price_uzs);
      const eff = effectivePrice(list, costs.get(id) ?? null, { discount_pct: r.discount_pct, campaign_price_uzs: r.campaign_price_uzs == null ? null : Number(r.campaign_price_uzs) }, guard);
      if (!eff) continue;
      const p = r.promotion;
      out.set(id, {
        product_id: id,
        list_price_uzs: list,
        price_uzs: eff.price_uzs,
        discount_pct: eff.discount_pct,
        campaign: { id: p.id, slug: p.slug ?? p.id, skin: (p.skin ?? 'none') as CampaignSkinCode, title_ru: p.title_ru ?? p.name, title_uz: p.title_uz, ends_at: p.open_ended ? null : p.end_at },
      });
    }
    return out;
  }

  /** Product lists of the shop: a product in a running sale gets its sale price, the regular one crossed out and the badge. */
  async decorate<T extends ProductListItem>(items: T[], db: Db = this.prisma, now = new Date()): Promise<T[]> {
    const map = await this.running(db, items.map((i) => i.id), now);
    return items.map((i) => apply(i, map.get(i.id)));
  }

  /** The product page: the product itself and its «Похожие» / «С этим покупают». */
  async decorateCard<T extends ProductListItem & { similar: ProductListItem[]; also_bought: ProductListItem[] }>(card: T, now = new Date()): Promise<T> {
    const map = await this.running(this.prisma, [card.id, ...card.similar.map((p) => p.id), ...card.also_bought.map((p) => p.id)], now);
    return { ...apply(card, map.get(card.id)), similar: card.similar.map((p) => apply(p, map.get(p.id))), also_bought: card.also_bought.map((p) => apply(p, map.get(p.id))) };
  }

  /** Running sales with at least one product on sale: the first slides of the home carousel, the soonest end first. */
  async shopList(now = new Date()): Promise<ShopCampaignSummary[]> {
    const promos = await this.prisma.promotions.findMany({
      where: RUNNING(now),
      include: { targets: { where: { product: { status: 'active' } }, select: { product_id: true } } },
      orderBy: [{ end_at: 'asc' }, { start_at: 'asc' }],
    });
    if (!promos.length) return [];
    const map = await this.running(this.prisma, promos.flatMap((p) => p.targets.map((t) => t.product_id!)), now);
    return promos.flatMap((p) => {
      const mine = [...map.values()].filter((c) => c.campaign.id === p.id);
      if (!mine.length) return [];
      const c = mine[0].campaign;
      return [{ id: p.id, slug: c.slug, skin: c.skin, title_ru: c.title_ru, title_uz: c.title_uz, ends_at: c.ends_at, max_discount_pct: Math.max(...mine.map((m) => m.discount_pct)), products_count: mine.length }];
    });
  }

  /** «Все товары акции»: in stock first, the biggest discount first. Not running (yet or any more) — 404. */
  async shopPage(slug: string, now = new Date()) {
    const p = await this.prisma.promotions.findFirst({ where: { kind: 'campaign', slug }, include: { targets: { select: { product_id: true } } } });
    if (!p || !(p.status === 'active' && p.start_at <= now && p.end_at > now)) throw new NotFoundException({ code: 'CAMPAIGN_NOT_RUNNING', message: 'The sale is not running' });
    const products = await this.prisma.products.findMany({ where: { id: { in: p.targets.map((t) => t.product_id!).filter(Boolean) }, status: 'active' }, include: listInclude });
    const items = (await this.decorate(products.map(toProductListItem), this.prisma, now))
      .filter((i) => i.campaign?.id === p.id)
      .sort((a, b) => Number(b.in_stock) - Number(a.in_stock) || b.campaign!.discount_pct - a.campaign!.discount_pct || a.price_uzs - b.price_uzs);
    const summary = (await this.shopList(now)).find((s) => s.id === p.id);
    return {
      campaign: summary ?? { id: p.id, slug, skin: (p.skin ?? 'none') as CampaignSkinCode, title_ru: p.title_ru ?? p.name, title_uz: p.title_uz, ends_at: p.open_ended ? null : p.end_at, max_discount_pct: 0, products_count: 0 },
      items,
    };
  }

  @Interval('campaign-start', 60_000)
  async tick() {
    if (this.notifying) return;
    this.notifying = true;
    try {
      await this.notifyStarted();
    } catch (e) {
      this.logger.error('Campaign start notifications failed', e as Error);
    } finally {
      this.notifying = false;
    }
  }

  /**
   * «Сообщить о старте акции»: once per sale (start_notified_at is claimed first, so two API instances never send it
   * twice). Everybody gets it in the Mini App centre; the bot only those with «Получать акции и новости» (the worker
   * checks it again). Not at night: from 22:00 to 08:00 both wait until the morning.
   */
  async notifyStarted(now = new Date()): Promise<number> {
    const due = await this.prisma.promotions.findMany({ where: { ...RUNNING(now), notify_start: true, start_notified_at: null }, select: { id: true } });
    let sent = 0;
    for (const { id } of due) {
      const claimed = await this.prisma.promotions.updateMany({ where: { id, start_notified_at: null }, data: { start_notified_at: now } });
      if (!claimed.count) continue;
      const summary = (await this.shopList(now)).find((s) => s.id === id);
      if (!summary) continue; // nothing on sale (all products ended at their floor or are hidden): no message
      const msg = startMessage(summary);
      const users = await this.prisma.users.findMany({ where: { status: 'active', deleted_at: null }, select: { id: true, telegram_user_id: true, language: true, marketing_opt_in: true } });
      const at = quietUntil(now) ?? now;
      const res = await this.prisma.notifications.createMany({
        data: users.map((u) => ({
          user_id: u.id,
          chat_id: u.telegram_user_id,
          kind: 'marketing',
          category: 'promo',
          template: 'promo.message',
          // the bot only with «Получать акции и новости»; «centre» rows are never sent, only shown in the Mini App
          status: u.marketing_opt_in ? 'queued' : 'centre',
          next_attempt_at: at,
          dedup_key: `campaign:${id}:${u.id}`,
          payload: { order_number: '', lang: u.language, ...msg, open_path: `/campaign/${summary.slug}`, open_button: 'link', campaign_id: id },
        })),
        skipDuplicates: true,
      });
      sent += res.count;
      this.logger.log(`Campaign ${id} started: ${res.count} notifications (send at ${at.toISOString()})`);
    }
    return sent;
  }
}

function apply<T extends ProductListItem>(item: T, c: ProductCampaign | undefined): T {
  return c ? { ...item, price_uzs: c.price_uzs, old_price_uzs: c.list_price_uzs, campaign: toShopCampaign(c) } : item;
}

@ApiTags('catalog')
@Controller('catalog/campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  /** Running sales (the home slides): title, skin, end, max %, number of products. */
  @Get()
  list() {
    return this.campaigns.shopList();
  }

  @Get(':slug')
  page(@Param('slug') slug: string) {
    return this.campaigns.shopPage(slug);
  }
}
