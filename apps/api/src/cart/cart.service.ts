import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { listInclude, toProductListItem } from '../catalog/product.mapper';
import { DeliveryService } from '../delivery/delivery.service';
import { DeliveryQuote } from '../delivery/delivery-quote';
import { StockService } from '../inventory/stock.service';
import { PrismaService } from '../prisma/prisma.service';
import { CartWarning, MAX_LINE_QTY, reconcileCartLine } from './cart-reconcile';

export interface CartLineView {
  product_id: string;
  sku: string;
  name_ru: string;
  name_uz: string | null;
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
  goods_total_uzs: number; // available lines only; no promo discounts yet
  discount_total_uzs: number;
  items_count: number;
  can_checkout: boolean;
  delivery: DeliveryQuote | null;
}

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly delivery: DeliveryService,
  ) {}

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
    const goodsTotal = sellable.reduce((s, l) => s + l.line_total_uzs, 0);
    return {
      items: lines,
      warnings,
      goods_total_uzs: goodsTotal,
      discount_total_uzs: 0,
      items_count: sellable.reduce((s, l) => s + l.qty, 0),
      can_checkout: sellable.length > 0,
      delivery: address && sellable.length ? await this.delivery.quote(address.region_id, address.city_id, goodsTotal) : null,
    };
  }

  /**
   * Units that can be ordered now, for the cart badge. Read-only on purpose: unlike getCart() it does not
   * persist price/qty corrections, so the warnings are still shown when the customer opens the cart.
   */
  async count(userId: string): Promise<{ items_count: number }> {
    const items = await this.prisma.cart_items.findMany({
      where: { cart: { user_id: userId, status: 'active' }, product: { status: 'active' } },
      select: { product_id: true, qty: true },
    });
    const available = await this.stock.availability(items.map((i) => i.product_id));
    const count = items.reduce((s, i) => s + Math.min(i.qty, available.get(i.product_id) ?? 0, MAX_LINE_QTY), 0);
    return { items_count: count };
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
