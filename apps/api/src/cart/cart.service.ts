import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { listInclude, toProductListItem } from '../catalog/product.mapper';
import { DeliveryService } from '../delivery/delivery.service';
import { DeliveryQuote } from '../delivery/delivery-quote';
import { StockService } from '../inventory/stock.service';
import { PrismaService } from '../prisma/prisma.service';
import { PromoCodesService, PromoView } from '../promo/promo.service';
import { SettingsService } from '../settings/settings.service';
import { CartWarning, MAX_LINE_QTY, reconcileCartLine } from './cart-reconcile';
import { rankUpsell, UPSELL_MIN_COUNT } from './upsell';

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
  unit_price_uzs: number;
  line_total_uzs: number;
}

export interface CartView {
  items: CartLineView[];
  warnings: CartWarning[];
  goods_total_uzs: number; // available lines only
  discount_total_uzs: number; // 3.3: the promo code's goods discount
  items_count: number;
  can_checkout: boolean;
  delivery: DeliveryQuote | null;
  /** 3.3: the applied promo code (null — none or it stopped fitting, see warnings `promo_removed`). */
  promo: PromoView | null;
}

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly delivery: DeliveryService,
    private readonly settings: SettingsService,
    private readonly promo: PromoCodesService,
  ) {}

  /**
   * 3.1: products under «Добавьте ещё X сум — доставка бесплатна»: in stock, not in the cart, priced close to the
   * missing amount (see rankUpsell). Nothing when the block is off, the threshold is reached, the delivery is free as
   * the first order, no city is chosen yet, or fewer than 2 products fit. Read-only, like count().
   */
  async upsell(userId: string, address?: { region_id: string; city_id: string }) {
    const none = { items: [] as ReturnType<typeof toProductListItem>[], source: null as 'auto' | 'manual' | null, remaining_uzs: 0 };
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
    const items = rankUpsell(products.map(toProductListItem).filter((p) => p.in_stock), quote.remaining_for_free_uzs);
    return items.length >= UPSELL_MIN_COUNT ? { items, source, remaining_uzs: quote.remaining_for_free_uzs } : none;
  }

  /** Opening the cart re-validates every line (price, stock, product status) and persists corrections. */
  async getCart(userId: string, address?: { region_id: string; city_id: string }, extraWarnings: CartWarning[] = []): Promise<CartView> {
    const cart = await this.prisma.carts.findFirst({
      where: { user_id: userId, status: 'active' },
      include: { items: { orderBy: { created_at: 'asc' }, include: { product: { include: listInclude } } } },
    });
    const items = cart?.items ?? [];
    const available = await this.stock.availability(items.map((i) => i.product_id));

    const lines: CartLineView[] = [];
    const warnings: CartWarning[] = [...extraWarnings];
    for (const item of items) {
      const product = toProductListItem(item.product);
      const r = reconcileCartLine({
        product_id: item.product_id,
        qty: item.qty,
        snapshot_price_uzs: Number(item.unit_price_snapshot_uzs),
        current_price_uzs: product.price_uzs,
        sellable: item.product.status === 'active',
        available_qty: available.get(item.product_id) ?? 0,
      });
      // Persist corrections so each warning is shown once and the cart stays consistent between sessions.
      if (r.status === 'available' && (r.qty !== item.qty || r.unit_price_uzs !== Number(item.unit_price_snapshot_uzs))) {
        await this.prisma.cart_items.update({
          where: { id: item.id },
          data: { qty: r.qty, unit_price_snapshot_uzs: BigInt(r.unit_price_uzs) },
        });
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
        available_qty: Math.min(available.get(item.product_id) ?? 0, MAX_LINE_QTY),
        unit_price_uzs: r.unit_price_uzs,
        line_total_uzs: r.unit_price_uzs * r.qty,
      });
    }

    const sellable = lines.filter((l) => l.status === 'available');
    // 3.3: the same calculation as the checkout; a saved code that stopped fitting is removed with a hint
    const calc = await this.promo.calculate(this.prisma, userId, sellable, { address: sellable.length ? address : null, code: cart?.promo_code });
    if (cart?.promo_code && calc.promo_rejection) {
      await this.prisma.carts.update({ where: { id: cart.id }, data: { promo_code: null } });
      const r = calc.promo_rejection;
      warnings.push({ code: 'promo_removed', promo_code: r.code, reason: r.reason, message_ru: r.message_ru, message_uz: r.message_uz });
    }
    return {
      items: lines,
      warnings,
      goods_total_uzs: calc.totals.goods_total_uzs,
      discount_total_uzs: calc.totals.discount_total_uzs,
      items_count: sellable.reduce((s, l) => s + l.qty, 0),
      can_checkout: sellable.length > 0,
      delivery: calc.delivery,
      promo: calc.promo,
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

  /** Orderable lines at current prices, read-only (see count()). */
  private async countLines(userId: string): Promise<{ product_id: string; qty: number; unit_price_uzs: number }[]> {
    const items = await this.prisma.cart_items.findMany({
      where: { cart: { user_id: userId, status: 'active' }, product: { status: 'active' } },
      select: { product_id: true, qty: true, product: { select: { price_uzs: true } } },
    });
    const available = await this.stock.availability(items.map((i) => i.product_id));
    return items
      .map((i) => ({ product_id: i.product_id, qty: Math.min(i.qty, available.get(i.product_id) ?? 0, MAX_LINE_QTY), unit_price_uzs: Number(i.product.price_uzs) }))
      .filter((l) => l.qty > 0);
  }

  async addItem(userId: string, productId: string, qty: number): Promise<CartView> {
    const product = await this.findSellableProduct(productId);
    const available = (await this.stock.availability([productId])).get(productId) ?? 0;
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
    const available = (await this.stock.availability([productId])).get(productId) ?? 0;
    if (available <= 0) throw new ConflictException({ code: 'OUT_OF_STOCK', message: 'Product is out of stock' });
    return this.writeLine(userId, cart.id, productId, product.price_uzs, qty, available);
  }

  async removeItem(userId: string, productId: string): Promise<CartView> {
    await this.prisma.cart_items.deleteMany({ where: { product_id: productId, cart: { user_id: userId, status: 'active' } } });
    return this.getCart(userId);
  }

  private async writeLine(userId: string, cartId: string, productId: string, price: bigint, wanted: number, available: number) {
    const limit = Math.min(available, MAX_LINE_QTY);
    const qty = Math.min(wanted, limit);
    const warnings: CartWarning[] =
      wanted > limit ? [{ code: 'qty_reduced', product_id: productId, requested_qty: wanted, available_qty: limit }] : [];
    await this.prisma.cart_items.upsert({
      where: { cart_id_product_id: { cart_id: cartId, product_id: productId } },
      create: { cart_id: cartId, product_id: productId, qty, unit_price_snapshot_uzs: price },
      update: { qty, unit_price_snapshot_uzs: price },
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
