import { Controller, Get, Injectable, Module, NotFoundException, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { availableQty, listInclude, ProductListItem, toProductListItem } from '../catalog/product.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignsService } from '../promo/campaigns.service';
import { PromoCodesService } from '../promo/promo.service';
import { PromoModule } from '../promo/promo.module';
import { bundleDays, bundleDiscount } from './bundles';

export interface ShopBundle {
  id: string;
  slug: string;
  title_ru: string;
  title_uz: string | null;
  goal: string | null;
  doctor_text_ru: string | null;
  doctor_text_uz: string | null;
  discount_pct: number;
  /** the jars at the shop's prices now (a running sale included) */
  list_total_uzs: number;
  /** what the set costs in the cart (the set discount within the margin protection) */
  sale_total_uzs: number;
  /** «Хватит на X дней» — the shortest course of the set; null without the card data */
  days: number | null;
  items: { qty: number; product: ProductListItem }[];
}

/**
 * 4.3 «Сеты от врача» for the Mini App. A set is shown only while it is on and every jar is in stock (in its quantity);
 * its price is counted by the same rule as the cart.
 */
@Injectable()
export class BundlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignsService,
    private readonly promo: PromoCodesService,
  ) {}

  async list(): Promise<ShopBundle[]> {
    return this.load();
  }

  async bySlug(slug: string): Promise<ShopBundle> {
    const [b] = await this.load(slug);
    if (!b) throw new NotFoundException('Set not found');
    return b;
  }

  private async load(slug?: string): Promise<ShopBundle[]> {
    const rows = await this.prisma.bundles.findMany({
      where: { is_active: true, ...(slug && { slug }) },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
      include: { items: { orderBy: { sort_order: 'asc' }, include: { product: { include: listInclude } } } },
    });
    const guard = await this.promo.guard();
    const out: ShopBundle[] = [];
    for (const b of rows) {
      const visible = b.items.length >= 2 && b.items.every((i) => i.product.status === 'active' && !i.product.is_test && availableQty(i.product.inventory) >= i.qty);
      if (!visible) continue;
      const products = await this.campaigns.decorate(b.items.map((i) => toProductListItem(i.product)));
      const priced = b.items.map((i, k) => ({
        product_id: i.product_id,
        qty: i.qty,
        unit_price_uzs: products[k].price_uzs,
        ...(products[k].campaign && { list_price_uzs: products[k].campaign!.list_price_uzs, campaign: products[k].campaign }),
      }));
      const lines = await this.promo.pricingLines(this.prisma, priced);
      const list = priced.reduce((s, l) => s + l.unit_price_uzs * l.qty, 0);
      const off = bundleDiscount(lines, [{ id: b.id, title_ru: b.title_ru, title_uz: b.title_uz, discount_pct: b.discount_pct, items: b.items.map((i) => ({ product_id: i.product_id, qty: i.qty })) }], guard).total_uzs;
      out.push({
        id: b.id,
        slug: b.slug,
        title_ru: b.title_ru,
        title_uz: b.title_uz,
        goal: b.goal,
        doctor_text_ru: b.doctor_text_ru,
        doctor_text_uz: b.doctor_text_uz,
        discount_pct: b.discount_pct,
        list_total_uzs: list,
        sale_total_uzs: list - off,
        days: bundleDays(b.items.map((i) => ({ qty: i.qty, pack_count: i.product.pack_count, servings_per_day: i.product.servings_per_day }))),
        items: b.items.map((i, k) => ({ qty: i.qty, product: products[k] })),
      });
    }
    return out;
  }
}

@ApiTags('catalog')
@Controller('catalog/bundles')
export class BundlesController {
  constructor(private readonly bundles: BundlesService) {}

  /** «Сеты от врача» on the home page. */
  @Get()
  list() {
    return this.bundles.list();
  }

  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.bundles.bySlug(slug);
  }
}

@Module({ imports: [PromoModule], controllers: [BundlesController], providers: [BundlesService], exports: [BundlesService] })
export class BundlesModule {}
