import { Body, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { uniqueSlug } from '../catalog/brand-names';
import { PrismaService } from '../prisma/prisma.service';
import { CAMPAIGN_SKINS, campaignState, CampaignSkinCode, checkTarget, OPEN_END, periodsOverlap, TargetProblem } from '../promo/campaigns';
import { purchaseCosts } from '../promo/purchase-costs';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

const TX = { maxWait: 10_000, timeout: 20_000 };
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** One lock for every sale save: two saves at the same moment never put one product into two running sales. */
const SAVE_LOCK = 3_700_001;

export class CampaignItemDto {
  @ApiProperty() @IsUUID() product_id!: string;
  @ApiPropertyOptional({ description: 'Скидка, % (1–90); или campaign_price_uzs' }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(90) discount_pct?: number | null;
  @ApiPropertyOptional({ description: 'Акционная цена, сум; или discount_pct' }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(100) @Max(1_000_000_000) campaign_price_uzs?: number | null;
}

export class CampaignDto {
  @ApiProperty({ example: 'Распродажа 11.11' }) @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) title_ru!: string;
  @ApiPropertyOptional({ example: '11.11 chegirmalari' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(60) title_uz?: string;
  @ApiProperty({ enum: CAMPAIGN_SKINS }) @IsIn([...CAMPAIGN_SKINS]) skin!: CampaignSkinCode;
  @ApiProperty() @IsDateString() start_at!: string;
  @ApiPropertyOptional({ description: 'Пусто вместе с open_ended — без даты окончания (скидка до 25%)' }) @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() end_at?: string | null;
  @ApiProperty() @IsBoolean() open_ended!: boolean;
  @ApiProperty() @IsBoolean() active!: boolean;
  @ApiProperty({ description: '«Сообщить о старте акции»' }) @IsBoolean() notify_start!: boolean;
  @ApiProperty({ type: [CampaignItemDto] }) @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => CampaignItemDto) items!: CampaignItemDto[];
}

export class CampaignStatusDto {
  @ApiProperty() @IsBoolean() active!: boolean;
}

/** One product of the form: what it costs in the sale and what blocks the save. */
export interface CampaignItemCheck {
  product_id: string;
  sku: string;
  name: string;
  list_price_uzs: number;
  price_uzs: number;
  discount_pct: number;
  floor_uzs: number;
  max_pct: number;
  cost_known: boolean;
  problem: TargetProblem | 'unknown_product' | 'not_active' | null;
  /** another switched-on sale with this product at an overlapping time */
  conflict: { id: string; title: string } | null;
}

/**
 * 3.7: «Акции» in the admin panel (rows of promotions with kind = campaign, products in promotion_targets).
 * View: admin, manager, marketer; create / change / switch on and off: admin, marketer (same as promo codes, D-39 Б).
 * A sale is never deleted, only switched off; switching off brings the regular prices back at once.
 * The save is refused (422) while any product is above the limit (35% / 25% without an end), below the margin floor or
 * in another switched-on sale at the same time; the form calls /check while typing and shows the same answer.
 */
@Injectable()
export class AdminCampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.promotions.findMany({ where: { kind: 'campaign' }, include: { _count: { select: { targets: true } } }, orderBy: [{ start_at: 'desc' }, { created_at: 'desc' }] });
    // orders with the sale (from the frozen calculations), not cancelled, not test
    const stats = await this.prisma.$queryRaw<{ id: string; orders: number; amount: bigint }[]>`
      SELECT c->>'promotion_id' AS id, count(*)::int AS orders, coalesce(sum((c->>'amount_uzs')::bigint), 0)::bigint AS amount
      FROM orders o, jsonb_array_elements(CASE WHEN jsonb_typeof(o.pricing_json->'campaigns') = 'array' THEN o.pricing_json->'campaigns' ELSE '[]'::jsonb END) c
      WHERE o.status <> 'cancelled' AND o.is_test = false
      GROUP BY 1`;
    const now = new Date();
    return rows.map((p) => {
      const s = stats.find((x) => x.id === p.id);
      return { ...this.head(p), state: campaignState(p, now), products_count: p._count.targets, orders: s?.orders ?? 0, discount_total_uzs: Number(s?.amount ?? 0) };
    });
  }

  async get(id: string) {
    const p = await this.prisma.promotions.findFirst({ where: { id, kind: 'campaign' }, include: { targets: true } });
    if (!p) throw new NotFoundException('Campaign not found');
    const items = p.targets.filter((t) => t.product_id).map((t) => ({ product_id: t.product_id!, discount_pct: t.discount_pct, campaign_price_uzs: t.campaign_price_uzs == null ? null : Number(t.campaign_price_uzs) }));
    return { ...this.head(p), state: campaignState(p, new Date()), items, checks: (await this.check({ ...this.dtoOf(p), items }, id)).items };
  }

  /**
   * Products for the picker: active ones with brand, categories, regular price, the margin floor and the sales they are
   * already in (so «Добавить бренд / категорию» and the warnings work without a request per product).
   */
  async products() {
    const products = await this.prisma.products.findMany({
      where: { status: 'active' },
      select: { id: true, sku: true, name_ru: true, short_name_ru: true, price_uzs: true, brand: true, brand_id: true, categories: { select: { category_id: true } }, inventory: { select: { actual_qty: true, reserved_qty: true } } },
      orderBy: [{ brand: 'asc' }, { sku: 'asc' }],
    });
    const [brands, categories] = await Promise.all([
      this.prisma.brands.findMany({ where: { id: { in: [...new Set(products.map((p) => p.brand_id).filter((b): b is string => !!b))] } }, select: { id: true, name_ru: true }, orderBy: { name_ru: 'asc' } }),
      this.prisma.categories.findMany({ where: { status: 'active' }, select: { id: true, name_ru: true, tree_type: true }, orderBy: [{ tree_type: 'asc' }, { sort_order: 'asc' }] }),
    ]);
    return {
      products: products.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.short_name_ru || p.name_ru,
        price_uzs: Number(p.price_uzs),
        brand: p.brand,
        brand_id: p.brand_id,
        category_ids: p.categories.map((c) => c.category_id),
        in_stock: p.inventory.some((i) => i.actual_qty - i.reserved_qty > 0),
      })),
      brands,
      categories,
    };
  }

  /** What the form shows while typing (and what create / update refuse). `selfId` — the sale being edited. */
  async check(dto: Pick<CampaignDto, 'start_at' | 'end_at' | 'open_ended' | 'active' | 'items'>, selfId?: string, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const ids = [...new Set(dto.items.map((i) => i.product_id))];
    const { start, end } = period(dto);
    const [products, costs, guard, others] = await Promise.all([
      db.products.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, name_ru: true, short_name_ru: true, price_uzs: true, status: true } }),
      purchaseCosts(db, ids),
      this.settings.getOrDefault('promo_guard'),
      db.promotions.findMany({
        where: { kind: 'campaign', status: 'active', ...(selfId && { id: { not: selfId } }), end_at: { gt: start }, start_at: { lt: end }, targets: { some: { product_id: { in: ids } } } },
        include: { targets: { where: { product_id: { in: ids } }, select: { product_id: true } } },
      }),
    ]);
    const items: CampaignItemCheck[] = dto.items.map((i) => {
      const p = products.find((x) => x.id === i.product_id);
      if (!p) return { product_id: i.product_id, sku: '', name: '', list_price_uzs: 0, price_uzs: 0, discount_pct: 0, floor_uzs: 0, max_pct: 0, cost_known: false, problem: 'unknown_product', conflict: null };
      const cost = costs.get(p.id) ?? null;
      const c = checkTarget(Number(p.price_uzs), cost, { discount_pct: i.discount_pct ?? null, campaign_price_uzs: i.campaign_price_uzs ?? null }, guard, dto.open_ended);
      const other = dto.active ? others.find((o) => o.targets.some((t) => t.product_id === p.id) && periodsOverlap({ start_at: start, end_at: end }, o)) : undefined;
      return {
        product_id: p.id,
        sku: p.sku,
        name: p.short_name_ru || p.name_ru,
        list_price_uzs: Number(p.price_uzs),
        price_uzs: c.price_uzs,
        discount_pct: c.discount_pct,
        floor_uzs: c.floor_uzs,
        max_pct: c.max_pct,
        cost_known: cost != null,
        problem: c.problem ?? (p.status !== 'active' ? 'not_active' : null),
        conflict: other ? { id: other.id, title: other.title_ru ?? other.name } : null,
      };
    });
    // a hidden product does not block the save (it is simply not sold); everything else does
    const blocking = items.filter((i) => (i.problem && i.problem !== 'not_active') || i.conflict);
    return { guard, items, ok: blocking.length === 0, blocking: blocking.length };
  }

  async create(staffId: string, dto: CampaignDto) {
    this.validate(dto);
    const id = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SAVE_LOCK}::bigint)`;
      await this.refuseInvalid(tx, dto);
      const taken = new Set((await tx.promotions.findMany({ where: { slug: { not: null } }, select: { slug: true } })).map((r) => r.slug!));
      const p = await tx.promotions.create({ data: { ...this.fields(dto), slug: uniqueSlug(dto.title_ru, taken, 'aksiya') } });
      await this.writeItems(tx, p.id, dto);
      await this.audit.log({ staffId, action: 'campaign.created', entityType: 'promotion', entityId: p.id, after: dto }, tx);
      return p.id;
    }, TX);
    return this.get(id);
  }

  /** Everything may change; the address (slug) stays, so links and messages keep working. Orders keep their prices. */
  async update(staffId: string, id: string, dto: CampaignDto) {
    this.validate(dto);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SAVE_LOCK}::bigint)`;
      const before = await tx.promotions.findFirst({ where: { id, kind: 'campaign' }, include: { targets: true } });
      if (!before) throw new NotFoundException('Campaign not found');
      await this.refuseInvalid(tx, dto, id);
      await tx.promotions.update({ where: { id }, data: this.fields(dto) });
      await tx.promotion_targets.deleteMany({ where: { promotion_id: id } }); // the sale's own product list, rewritten as a whole
      await this.writeItems(tx, id, dto);
      await this.audit.log({ staffId, action: 'campaign.updated', entityType: 'promotion', entityId: id, before: { ...this.head(before), items: before.targets.length }, after: dto }, tx);
    }, TX);
    return this.get(id);
  }

  /** «Выключить» brings the regular prices back at once; «Включить» checks the rules again. */
  async setActive(staffId: string, id: string, active: boolean) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SAVE_LOCK}::bigint)`;
      const p = await tx.promotions.findFirst({ where: { id, kind: 'campaign' }, include: { targets: true } });
      if (!p) throw new NotFoundException('Campaign not found');
      if (active) {
        const items = p.targets.filter((t) => t.product_id).map((t) => ({ product_id: t.product_id!, discount_pct: t.discount_pct, campaign_price_uzs: t.campaign_price_uzs == null ? null : Number(t.campaign_price_uzs) }));
        await this.refuseInvalid(tx, { ...this.dtoOf(p), active: true, items }, id);
      }
      await tx.promotions.update({ where: { id }, data: { status: active ? 'active' : 'disabled' } });
      await this.audit.log({ staffId, action: active ? 'campaign.enabled' : 'campaign.disabled', entityType: 'promotion', entityId: id, before: { status: p.status }, after: { status: active ? 'active' : 'disabled' } }, tx);
    }, TX);
    return this.get(id);
  }

  private validate(dto: CampaignDto) {
    if (!dto.open_ended && !dto.end_at) throw new UnprocessableEntityException({ code: 'BAD_DATES', message: 'Укажите дату окончания или отметьте «Без даты окончания»' });
    const { start, end } = period(dto);
    if (end <= start) throw new UnprocessableEntityException({ code: 'BAD_DATES', message: 'Дата окончания должна быть позже даты начала' });
    if (!dto.items.length) throw new UnprocessableEntityException({ code: 'NO_ITEMS', message: 'Добавьте товары в акцию' });
    if (new Set(dto.items.map((i) => i.product_id)).size !== dto.items.length) throw new UnprocessableEntityException({ code: 'DUPLICATE_ITEMS', message: 'Товар добавлен в акцию дважды' });
  }

  private async refuseInvalid(tx: Prisma.TransactionClient, dto: Pick<CampaignDto, 'start_at' | 'end_at' | 'open_ended' | 'active' | 'items'>, selfId?: string) {
    const res = await this.check(dto, selfId, tx);
    if (!res.ok) throw new UnprocessableEntityException({ code: 'CAMPAIGN_INVALID', message: 'Исправьте товары, отмеченные красным', items: res.items });
  }

  private fields(dto: CampaignDto) {
    const { start, end } = period(dto);
    return {
      kind: 'campaign' as const,
      name: dto.title_ru,
      title_ru: dto.title_ru,
      title_uz: dto.title_uz || null,
      skin: dto.skin,
      type: 'percent' as const, // not used by a sale: each product has its own discount (promotion_targets)
      value: new Prisma.Decimal(0),
      scope_type: 'product' as const,
      start_at: start,
      end_at: end,
      open_ended: dto.open_ended,
      notify_start: dto.notify_start,
      status: dto.active ? ('active' as const) : ('disabled' as const),
      stacking_mode: 'compatible' as const, // a promo code may add to a sale of up to 15% (D-39)
    };
  }

  private async writeItems(tx: Prisma.TransactionClient, promotionId: string, dto: CampaignDto) {
    await tx.promotion_targets.createMany({
      data: dto.items.map((i) => ({
        promotion_id: promotionId,
        product_id: i.product_id,
        discount_pct: i.campaign_price_uzs != null ? null : (i.discount_pct ?? null),
        campaign_price_uzs: i.campaign_price_uzs != null ? BigInt(i.campaign_price_uzs) : null,
      })),
    });
  }

  private dtoOf(p: { start_at: Date; end_at: Date; open_ended: boolean; status: string }) {
    return { start_at: p.start_at.toISOString(), end_at: p.open_ended ? null : p.end_at.toISOString(), open_ended: p.open_ended, active: p.status === 'active' };
  }

  private head(p: Prisma.promotionsGetPayload<object>) {
    return {
      id: p.id,
      slug: p.slug,
      title_ru: p.title_ru ?? p.name,
      title_uz: p.title_uz,
      skin: (p.skin ?? 'none') as CampaignSkinCode,
      start_at: p.start_at,
      end_at: p.open_ended ? null : p.end_at,
      open_ended: p.open_ended,
      active: p.status === 'active',
      notify_start: p.notify_start,
      start_notified_at: p.start_notified_at,
      created_at: p.created_at,
    };
  }
}

function period(dto: Pick<CampaignDto, 'start_at' | 'end_at' | 'open_ended'>) {
  return { start: new Date(dto.start_at), end: dto.open_ended || !dto.end_at ? OPEN_END : new Date(dto.end_at) };
}

@ApiTags('staff: campaigns')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/campaigns')
export class AdminCampaignsController {
  constructor(private readonly campaigns: AdminCampaignsService) {}

  @Get()
  @RequirePermission('promo.view')
  list() {
    return this.campaigns.list();
  }

  @Get('products')
  @RequirePermission('promo.view')
  products() {
    return this.campaigns.products();
  }

  /** The form asks while typing: price in the sale, limit, margin floor, another sale at the same time. */
  @Post('check')
  @HttpCode(200)
  @RequirePermission('promo.view')
  check(@Body() dto: CampaignDto) {
    return this.campaigns.check(dto);
  }

  @Post(':id/check')
  @HttpCode(200)
  @RequirePermission('promo.view')
  checkExisting(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CampaignDto) {
    return this.campaigns.check(dto, id);
  }

  @Get(':id')
  @RequirePermission('promo.view')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.campaigns.get(id);
  }

  @Post()
  @RequirePermission('promo.manage')
  create(@CurrentStaff() me: StaffContext, @Body() dto: CampaignDto) {
    return this.campaigns.create(me.staff.id, dto);
  }

  @Put(':id')
  @RequirePermission('promo.manage')
  update(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CampaignDto) {
    return this.campaigns.update(me.staff.id, id, dto);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('promo.manage')
  setActive(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CampaignStatusDto) {
    return this.campaigns.setActive(me.staff.id, id, dto.active);
  }
}
