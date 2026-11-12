import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { listInclude, ShopCampaign, toProductListItem } from '../catalog/product.mapper';
import { DeliveryService } from '../delivery/delivery.service';
import { DeliveryQuote } from '../delivery/delivery-quote';
import { StockService } from '../inventory/stock.service';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignsService, toShopCampaign } from '../promo/campaigns.service';
import { BonusView, CampaignLine, PromoCodesService, PromoView } from '../promo/promo.service';
import { SettingsService } from '../settings/settings.service';
import { underOrderMark, windowView, type SupplyTerms, type UnderOrderMark, type WindowView } from '../orders/cross-border';
import { CartWarning, MAX_LINE_QTY, reconcileCartLine } from './cart-reconcile';
import { rankUpsell, UPSELL_COUNT, UPSELL_MIN_COUNT, UPSELL_SPARE } from './upsell';

export interface CartLineView {
  product_id: string;
  sku: string;
  name_ru: string;
  name_uz: string | null;
  short_name_ru: string | null;
  short_name_uz: string | null;
  form: string | null;
  brand: string;
  image_url: string | null;
  status: 'available' | 'unavailable';
  qty: number;
  available_qty: number;
  /** D-60: nothing in Tashkent — the line comes «Под заказ из США» (prepayment only, all delivered together) */
  cross_border: boolean;
  /** D-61: «Из США» or «Под заказ» (null — from the Tashkent stock) */
  under_order: UnderOrderMark | null;
  unit_price_uzs: number;
  line_total_uzs: number;
  /** 3.7: the regular price (= unit_price_uzs when the product is not in a running sale) and the sale */
  list_price_uzs: number;
  campaign: ShopCampaign | null;
}

export interface CartView {
  items: CartLineView[];
  warnings: CartWarning[];
  goods_total_uzs: number; // available lines only, at the prices charged (sale prices included)
  /** 3.7: goods at regular prices and «Акция 11.11: −X сум» lines */
  goods_list_total_uzs: number;
  campaign_discount_uzs: number;
  campaigns: CampaignLine[];
  discount_total_uzs: number; // 3.3: the promo code's goods discount
  items_count: number;
  can_checkout: boolean;
  delivery: DeliveryQuote | null;
  /** 3.3: the applied promo code (null — none or it stopped fitting, see warnings `promo_removed`). */
  promo: PromoView | null;
  /** 3.10-А: VITALO Bonus — the balance, what may be spent, the switch, «+N сум» after the delivery */
  bonus: BonusView;
  bonus_used_uzs: number;
  /** D-60: the cart has lines from the USA — the promised delivery window counted from today (YYYY-MM-DD) */
  cross_border: WindowView | null;
}

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly delivery: DeliveryService,
    private readonly settings: SettingsService,
    private readonly promo: PromoCodesService,
    private readonly campaigns: CampaignsService,
  ) {}

  /**
   * 3.1: products under «Добавьте ещё X сум — доставка бесплатна»: in stock, not in the cart, priced close to the
   * missing amount (see rankUpsell). Nothing when the block is off, the threshold is reached, the delivery is free as
   * the first order, no city is chosen yet, or fewer than 2 products fit. Read-only, like count().
   * 3.5: up to 3 more products come as `spare`: the strip shows the next one in place of a card just added.
   */
  async upsell(userId: string, address?: { region_id: string; city_id: string }) {
    const none = { items: [] as ReturnType<typeof toProductListItem>[], spare: [] as ReturnType<typeof toProductListItem>[], source: null as 'auto' | 'manual' | null, remaining_uzs: 0 };
    const cfg = await this.settings.getOrDefault('cart_upsell');
    if (!cfg.enabled || !address) return none;
    const lines = await this.countLines(userId);
    if (!lines.length) return none;
    // 3.3: the threshold counts goods after the promo code, exactly as in the cart
    const cart = await this.prisma.carts.findFirst({ where: { user_id: userId, status: 'active' }, select: { promo_code: true } });
    const quote = (await this.promo.calculate(this.prisma, userId, lines, { address, code: cart?.promo_code })).delivery!;
    if (quote.is_free || quote.first_order || quote.remaining_for_free_uzs <= 0) return none;

    const inCart = (await this.prisma.cart_items.findMany({ where: { cart: { user_id: userId, status: 'active' } }, select: { product_id: true } })).map((i) => i.product_id);
    const manual = (cfg.product_ids ?? []).filter((id) => !inCart.includes(id));
    const source = cfg.product_ids?.length ? ('manual' as const) : ('auto' as const);
    if (source === 'manual' && !manual.length) return none;
    const products = await this.prisma.products.findMany({
      where: { status: 'active', id: source === 'manual' ? { in: manual } : { notIn: inCart }, price_uzs: { gt: 0 } },
      include: listInclude,
    });
    const ranked = rankUpsell((await this.campaigns.decorate(products.map(toProductListItem))).filter((p) => p.in_stock), quote.remaining_for_free_uzs, UPSELL_COUNT + UPSELL_SPARE);
    const items = ranked.slice(0, UPSELL_COUNT);
    return items.length >= UPSELL_MIN_COUNT ? { items, spare: ranked.slice(UPSELL_COUNT), source, remaining_uzs: quote.remaining_for_free_uzs } : none;
  }

  /** Opening the cart re-validates every line (price, stock, product status) and persists corrections. 3.5: the newest line first. */
  async getCart(userId: string, address?: { region_id: string; city_id: string }, extraWarnings: CartWarning[] = []): Promise<CartView> {
    const cart = await this.prisma.carts.findFirst({
      where: { user_id: userId, status: 'active' },
      include: { items: { orderBy: { created_at: 'desc' }, include: { product: { include: listInclude } } } },
    });
    const items = cart?.items ?? [];
    const available = await this.stock.orderable(items.map((i) => i.product_id), MAX_LINE_QTY);
    // 3.7: the sale prices of now; the sales the snapshots came from (for «Акция завершилась»)
    const products = await this.campaigns.decorate(items.map((i) => toProductListItem(i.product)));
    const endedIds = [...new Set(items.map((i) => i.campaign_id).filter((id): id is string => !!id && !products.some((p) => p.campaign?.id === id)))];
    const ended = endedIds.length ? await this.prisma.promotions.findMany({ where: { id: { in: endedIds } }, select: { id: true, name: true, title_ru: true, title_uz: true } }) : [];

    const lines: CartLineView[] = [];
    const warnings: CartWarning[] = [...extraWarnings];
    for (const [idx, item] of items.entries()) {
      const product = products[idx];
      const campaignId = product.campaign?.id ?? null;
      const r = reconcileCartLine({
        product_id: item.product_id,
        qty: item.qty,
        snapshot_price_uzs: Number(item.unit_price_snapshot_uzs),
        current_price_uzs: product.price_uzs,
        snapshot_campaign_id: item.campaign_id,
        current_campaign_id: campaignId,
        sellable: item.product.status === 'active',
        available_qty: available.get(item.product_id)?.qty ?? 0,
      });
      // Persist corrections so each warning is shown once and the cart stays consistent between sessions.
      if (r.status === 'available' && (r.qty !== item.qty || r.unit_price_uzs !== Number(item.unit_price_snapshot_uzs) || campaignId !== item.campaign_id)) {
        await this.prisma.cart_items.update({
          where: { id: item.id },
          data: { qty: r.qty, unit_price_snapshot_uzs: BigInt(r.unit_price_uzs), campaign_id: campaignId },
        });
      }
      for (const w of r.warnings) {
        if (w.code !== 'campaign_ended') continue;
        const c = ended.find((e) => e.id === item.campaign_id);
        Object.assign(w, { campaign_title_ru: c?.title_ru ?? c?.name, campaign_title_uz: c?.title_uz ?? null });
      }
      warnings.push(...r.warnings.filter((w) => !extraWarnings.some((e) => e.code === w.code && e.product_id === w.product_id)));
      lines.push({
        product_id: item.product_id,
        sku: product.sku,
        name_ru: product.name_ru,
        name_uz: product.name_uz,
        short_name_ru: product.short_name_ru,
        short_name_uz: product.short_name_uz,
        form: product.form,
        brand: product.brand,
        image_url: product.image_url,
        status: r.status,
        qty: r.qty,
        available_qty: available.get(item.product_id)?.qty ?? 0,
        cross_border: r.status === 'available' && !!available.get(item.product_id)?.cross_border,
        under_order: r.status === 'available' ? underOrderMark(available.get(item.product_id)?.terms) : null,
        unit_price_uzs: r.unit_price_uzs,
        line_total_uzs: r.unit_price_uzs * r.qty,
        list_price_uzs: product.campaign?.list_price_uzs ?? r.unit_price_uzs,
        campaign: product.campaign,
      });
    }

    const sellable = lines.filter((l) => l.status === 'available');
    // 3.3: the same calculation as the checkout; a saved code that stopped fitting is removed with a hint
    const calc = await this.promo.calculate(this.prisma, userId, sellable, { address: sellable.length ? address : null, code: cart?.promo_code, useBonus: !!cart?.use_bonus });
    if (cart?.promo_code && calc.promo_rejection) {
      await this.prisma.carts.update({ where: { id: cart.id }, data: { promo_code: null } });
      const r = calc.promo_rejection;
      warnings.push({ code: 'promo_removed', promo_code: r.code, reason: r.reason, message_ru: r.message_ru, message_uz: r.message_uz });
    }
    return {
      items: lines,
      warnings,
      goods_total_uzs: calc.totals.goods_total_uzs,
      goods_list_total_uzs: calc.totals.goods_list_total_uzs,
      campaign_discount_uzs: calc.totals.campaign_discount_uzs,
      campaigns: calc.snapshot.campaigns ?? [],
      discount_total_uzs: calc.totals.discount_total_uzs,
      items_count: sellable.reduce((s, l) => s + l.qty, 0),
      can_checkout: sellable.length > 0,
      delivery: calc.delivery,
      promo: calc.promo,
      bonus: calc.bonus,
      bonus_used_uzs: calc.totals.bonus_used_uzs,
      // D-60/D-61: «Ожидаемая доставка: 18–25 ноября» for «под заказ» lines, counted from today (the longest supplier)
      cross_border: windowView(sellable.filter((l) => l.cross_border).map((l) => available.get(l.product_id)?.terms).filter((t): t is SupplyTerms => !!t)),
    };
  }

  /**
   * 3.3: «У меня есть промокод» — checks the code against the cart (and the district, when given) and keeps it on the
   * cart; a code that does not fit is not kept and comes back as 422 with the reason and the customer text.
   */
  async applyPromo(userId: string, input: string, address?: { region_id: string; city_id: string }): Promise<CartView> {
    const cart = await this.getOrCreateActiveCart(userId);
    const view = await this.getCart(userId, address);
    const calc = await this.promo.calculate(this.prisma, userId, view.items.filter((l) => l.status === 'available'), { address, code: input });
    if (!calc.promo) {
      const r = calc.promo_rejection!;
      throw new UnprocessableEntityException({ code: 'PROMO_REJECTED', promo_code: r.code, reason: r.reason, message_ru: r.message_ru, message_uz: r.message_uz });
    }
    await this.prisma.carts.update({ where: { id: cart.id }, data: { promo_code: calc.promo.code } });
    return this.getCart(userId, address);
  }

  /** 3.10-А: «Списать бонусы» — kept on the cart; with a promo code nothing is spent (the cart shows why). */
  async useBonus(userId: string, use: boolean, address?: { region_id: string; city_id: string }): Promise<CartView> {
    const cart = await this.getOrCreateActiveCart(userId);
    await this.prisma.carts.update({ where: { id: cart.id }, data: { use_bonus: use } });
    return this.getCart(userId, address);
  }

  async removePromo(userId: string, address?: { region_id: string; city_id: string }): Promise<CartView> {
    await this.prisma.carts.updateMany({ where: { user_id: userId, status: 'active' }, data: { promo_code: null } });
    return this.getCart(userId, address);
  }

  /**
   * Units that can be ordered now and their sum at current prices, for the cart badge and the floating cart bar.
   * Read-only on purpose: unlike getCart() it does not persist price/qty corrections, so the warnings are still
   * shown when the customer opens the cart.
   */
  async count(userId: string): Promise<{ items_count: number; goods_total_uzs: number }> {
    const lines = await this.countLines(userId);
    return {
      items_count: lines.reduce((s, l) => s + l.qty, 0),
      goods_total_uzs: lines.reduce((s, l) => s + l.qty * l.unit_price_uzs, 0),
    };
  }

  /** Orderable lines at current prices (3.7: sale prices included), read-only (see count()). */
  private async countLines(userId: string): Promise<{ product_id: string; qty: number; unit_price_uzs: number; list_price_uzs?: number; campaign?: ShopCampaign | null }[]> {
    const items = await this.prisma.cart_items.findMany({
      where: { cart: { user_id: userId, status: 'active' }, product: { status: 'active' } },
      select: { product_id: true, qty: true, product: { select: { price_uzs: true } } },
    });
    const available = await this.stock.orderable(items.map((i) => i.product_id), MAX_LINE_QTY);
    const sale = await this.campaigns.running(this.prisma, items.map((i) => i.product_id));
    return items
      .map((i) => {
        const c = sale.get(i.product_id);
        const qty = Math.min(i.qty, available.get(i.product_id)?.qty ?? 0);
        return c ? { product_id: i.product_id, qty, unit_price_uzs: c.price_uzs, list_price_uzs: c.list_price_uzs, campaign: toShopCampaign(c) } : { product_id: i.product_id, qty, unit_price_uzs: Number(i.product.price_uzs) };
      })
      .filter((l) => l.qty > 0);
  }

  async addItem(userId: string, productId: string, qty: number): Promise<CartView> {
    const product = await this.findSellableProduct(productId);
    const available = (await this.stock.orderable([productId], MAX_LINE_QTY)).get(productId)?.qty ?? 0;
    if (available <= 0) throw new ConflictException({ code: 'OUT_OF_STOCK', message: 'Product is out of stock' });

    const cart = await this.getOrCreateActiveCart(userId);
    const existing = await this.prisma.cart_items.findUnique({
      where: { cart_id_product_id: { cart_id: cart.id, product_id: productId } },
    });
    const wanted = (existing?.qty ?? 0) + qty;
    return this.writeLine(userId, cart.id, productId, product.price_uzs, wanted, available);
  }

  async setQty(userId: string, productId: string, qty: number): Promise<CartView> {
    const cart = await this.prisma.carts.findFirst({ where: { user_id: userId, status: 'active' } });
    const item = cart && (await this.prisma.cart_items.findUnique({ where: { cart_id_product_id: { cart_id: cart.id, product_id: productId } } }));
    if (!cart || !item) throw new NotFoundException('Product is not in the cart');

    const product = await this.findSellableProduct(productId);
    const available = (await this.stock.orderable([productId], MAX_LINE_QTY)).get(productId)?.qty ?? 0;
    if (available <= 0) throw new ConflictException({ code: 'OUT_OF_STOCK', message: 'Product is out of stock' });
    return this.writeLine(userId, cart.id, productId, product.price_uzs, qty, available);
  }

  async removeItem(userId: string, productId: string): Promise<CartView> {
    await this.prisma.cart_items.deleteMany({ where: { product_id: productId, cart: { user_id: userId, status: 'active' } } });
    return this.getCart(userId);
  }

  /** 3.7: the snapshot keeps the price charged now (a sale price too) and the sale it came from. */
  private async writeLine(userId: string, cartId: string, productId: string, regular: bigint, wanted: number, available: number) {
    const sale = (await this.campaigns.running(this.prisma, [productId])).get(productId);
    const price = sale ? BigInt(sale.price_uzs) : regular;
    const campaign_id = sale?.campaign.id ?? null;
    const limit = Math.min(available, MAX_LINE_QTY);
    const qty = Math.min(wanted, limit);
    const warnings: CartWarning[] =
      wanted > limit ? [{ code: 'qty_reduced', product_id: productId, requested_qty: wanted, available_qty: limit }] : [];
    await this.prisma.cart_items.upsert({
      where: { cart_id_product_id: { cart_id: cartId, product_id: productId } },
      create: { cart_id: cartId, product_id: productId, qty, unit_price_snapshot_uzs: price, campaign_id },
      update: { qty, unit_price_snapshot_uzs: price, campaign_id },
    });
    return this.getCart(userId, undefined, warnings);
  }

  private async findSellableProduct(productId: string) {
    const product = await this.prisma.products.findFirst({ where: { id: productId, status: 'active' } });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  /** One active cart per user (partial unique index carts_one_active); a parallel create falls back to a read. */
  private async getOrCreateActiveCart(userId: string) {
    const existing = await this.prisma.carts.findFirst({ where: { user_id: userId, status: 'active' } });
    if (existing) return existing;
    try {
      return await this.prisma.carts.create({ data: { user_id: userId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.prisma.carts.findFirstOrThrow({ where: { user_id: userId, status: 'active' } });
      }
      throw e;
    }
  }
}
