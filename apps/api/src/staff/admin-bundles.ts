import { Body, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { BUNDLE_MAX_DISCOUNT_PCT, BUNDLE_MAX_ITEMS, BUNDLE_MIN_ITEMS, BUNDLE_MIN_MARGIN_PCT, bundleMargin, BundleMargin } from '../bundles/bundles';
import { uniqueSlug } from '../catalog/brand-names';
import { availableQty } from '../catalog/product.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { purchaseCosts } from '../promo/purchase-costs';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const empty = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export class BundleItemDto {
  @ApiProperty() @IsUUID() product_id!: string;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(1) @Max(5) qty!: number;
}

export class BundleDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) title_ru!: string;
  @ApiPropertyOptional() @Transform(empty) @IsOptional() @IsString() @MaxLength(80) title_uz?: string | null;
  @ApiPropertyOptional() @Transform(empty) @IsOptional() @IsString() @MaxLength(40) goal?: string | null;
  @ApiPropertyOptional() @Transform(empty) @IsOptional() @IsString() @MaxLength(1500) doctor_text_ru?: string | null;
  @ApiPropertyOptional() @Transform(empty) @IsOptional() @IsString() @MaxLength(1500) doctor_text_uz?: string | null;
  @ApiProperty() @Type(() => Number) @IsInt() @Min(0) @Max(BUNDLE_MAX_DISCOUNT_PCT) discount_pct!: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() is_active?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(999) sort_order?: number;
  @ApiProperty({ type: [BundleItemDto] })
  @IsArray()
  @ArrayMinSize(BUNDLE_MIN_ITEMS)
  @ArrayMaxSize(BUNDLE_MAX_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => BundleItemDto)
  items!: BundleItemDto[];
}

export class BundleStatusDto {
  @ApiProperty() @IsBoolean() active!: boolean;
}

export interface BundleCheck extends BundleMargin {
  /** products of the set that are archived or out of stock now: the set is hidden in the Mini App */
  hidden_because: { product_id: string; sku: string; reason: 'inactive' | 'out_of_stock' }[];
  /** products without a purchase cost (the margin cannot be counted) */
  no_cost: string[];
}

/**
 * 4.3 «Сеты» (admin only: the margin shows purchase costs, D-66). 2–3 products, a discount of 0–10% and a margin of
 * at least 30% after it (D-13, D-75) — a set below that is not saved. The margin counts the regular prices: a running
 * sale is temporary, and the cart never takes a set discount below the margin floor anyway.
 */
@Injectable()
export class AdminBundlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.bundles.findMany({ orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }], include: { items: { orderBy: { sort_order: 'asc' } } } });
    return Promise.all(rows.map(async (b) => ({ ...this.head(b), items: b.items.map((i) => ({ product_id: i.product_id, qty: i.qty })), check: await this.check({ discount_pct: b.discount_pct, items: b.items }) })));
  }

  async get(id: string) {
    const b = await this.prisma.bundles.findUnique({ where: { id }, include: { items: { orderBy: { sort_order: 'asc' }, include: { product: { select: { id: true, sku: true, name_ru: true, short_name_ru: true, status: true } } } } } });
    if (!b) throw new NotFoundException('Set not found');
    return {
      ...this.head(b),
      doctor_text_ru: b.doctor_text_ru,
      doctor_text_uz: b.doctor_text_uz,
      items: b.items.map((i) => ({ product_id: i.product_id, qty: i.qty, sku: i.product.sku, name_ru: i.product.short_name_ru || i.product.name_ru, status: i.product.status })),
      check: await this.check({ discount_pct: b.discount_pct, items: b.items }),
    };
  }

  /** The form asks while typing: the price without and with the discount, the margin, what hides the set. */
  async check(dto: Pick<BundleDto, 'discount_pct' | 'items'>): Promise<BundleCheck> {
    const ids = dto.items.map((i) => i.product_id);
    const [products, costs] = await Promise.all([
      this.prisma.products.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, price_uzs: true, status: true, inventory: { select: { actual_qty: true, reserved_qty: true } } } }),
      purchaseCosts(this.prisma, ids),
    ]);
    const items = dto.items.map((i) => {
      const p = products.find((x) => x.id === i.product_id);
      return { price_uzs: p ? Number(p.price_uzs) : 0, cost_uzs: costs.get(i.product_id) ?? null, qty: i.qty };
    });
    const hidden_because: BundleCheck['hidden_because'] = [];
    for (const i of dto.items) {
      const p = products.find((x) => x.id === i.product_id);
      if (!p || p.status !== 'active') hidden_because.push({ product_id: i.product_id, sku: p?.sku ?? '', reason: 'inactive' });
      else if (availableQty(p.inventory) < i.qty) hidden_because.push({ product_id: i.product_id, sku: p.sku, reason: 'out_of_stock' });
    }
    const no_cost = dto.items.filter((i) => costs.get(i.product_id) == null).map((i) => products.find((p) => p.id === i.product_id)?.sku ?? i.product_id);
    return { ...bundleMargin(items, dto.discount_pct), hidden_because, no_cost };
  }

  async create(staffId: string, dto: BundleDto) {
    await this.assertSavable(dto);
    return this.prisma.$transaction(async (tx) => {
      const taken = new Set((await tx.bundles.findMany({ select: { slug: true } })).map((b) => b.slug));
      const b = await tx.bundles.create({ data: { ...this.fields(dto), slug: uniqueSlug(dto.title_ru, taken, 'set'), items: { create: this.items(dto) } } });
      await this.audit.log({ staffId, action: 'bundle.created', entityType: 'bundle', entityId: b.id, after: dto }, tx);
      return { id: b.id, slug: b.slug };
    });
  }

  async update(staffId: string, id: string, dto: BundleDto) {
    const before = await this.prisma.bundles.findUnique({ where: { id }, include: { items: true } });
    if (!before) throw new NotFoundException('Set not found');
    await this.assertSavable(dto);
    return this.prisma.$transaction(async (tx) => {
      await tx.bundle_items.deleteMany({ where: { bundle_id: id } }); // the set's own lines are replaced as a whole
      await tx.bundles.update({ where: { id }, data: { ...this.fields(dto), items: { create: this.items(dto) } } });
      await this.audit.log({ staffId, action: 'bundle.updated', entityType: 'bundle', entityId: id, before: { ...this.head(before), items: before.items.map((i) => ({ product_id: i.product_id, qty: i.qty })) }, after: dto }, tx);
      return { id, slug: before.slug };
    });
  }

  async setActive(staffId: string, id: string, active: boolean) {
    const b = await this.prisma.bundles.findUnique({ where: { id }, include: { items: true } });
    if (!b) throw new NotFoundException('Set not found');
    if (active) await this.assertSavable({ discount_pct: b.discount_pct, items: b.items });
    await this.prisma.$transaction(async (tx) => {
      await tx.bundles.update({ where: { id }, data: { is_active: active } });
      await this.audit.log({ staffId, action: active ? 'bundle.enabled' : 'bundle.disabled', entityType: 'bundle', entityId: id, before: { is_active: b.is_active }, after: { is_active: active } }, tx);
    });
    return { id, is_active: active };
  }

  /** 2–3 different products that exist, and a margin of at least 30% after the discount. */
  private async assertSavable(dto: Pick<BundleDto, 'discount_pct' | 'items'>) {
    const ids = dto.items.map((i) => i.product_id);
    if (new Set(ids).size !== ids.length) throw new UnprocessableEntityException({ code: 'BUNDLE_DUPLICATE', message: 'A product is twice in the set' });
    if ((await this.prisma.products.count({ where: { id: { in: ids } } })) !== ids.length) throw new UnprocessableEntityException({ code: 'BUNDLE_PRODUCT_NOT_FOUND', message: 'Unknown product' });
    const c = await this.check(dto);
    if (c.too_low) {
      throw new UnprocessableEntityException({
        code: c.margin_pct == null ? 'BUNDLE_NO_COST' : 'BUNDLE_MARGIN_LOW',
        margin_pct: c.margin_pct,
        min_pct: BUNDLE_MIN_MARGIN_PCT,
        no_cost: c.no_cost,
        message: c.margin_pct == null ? 'A product of the set has no purchase cost' : `The margin after the discount is below ${BUNDLE_MIN_MARGIN_PCT}%`,
      });
    }
  }

  private fields(dto: BundleDto) {
    return {
      title_ru: dto.title_ru,
      title_uz: dto.title_uz ?? null,
      goal: dto.goal ?? null,
      doctor_text_ru: dto.doctor_text_ru ?? null,
      doctor_text_uz: dto.doctor_text_uz ?? null,
      discount_pct: dto.discount_pct,
      ...(dto.is_active !== undefined && { is_active: dto.is_active }),
      ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }),
    };
  }

  private items(dto: BundleDto) {
    return dto.items.map((i, k) => ({ product_id: i.product_id, qty: i.qty, sort_order: k }));
  }

  private head(b: { id: string; slug: string; title_ru: string; title_uz: string | null; goal: string | null; discount_pct: number; is_active: boolean; sort_order: number }) {
    return { id: b.id, slug: b.slug, title_ru: b.title_ru, title_uz: b.title_uz, goal: b.goal, discount_pct: b.discount_pct, is_active: b.is_active, sort_order: b.sort_order };
  }
}

@ApiTags('staff')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/bundles')
export class AdminBundlesController {
  constructor(private readonly bundles: AdminBundlesService) {}

  @Get()
  @RequirePermission('bundles.manage')
  list() {
    return this.bundles.list();
  }

  @Post('check')
  @HttpCode(200)
  @RequirePermission('bundles.manage')
  check(@Body() dto: BundleDto) {
    return this.bundles.check(dto);
  }

  @Get(':id')
  @RequirePermission('bundles.manage')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.bundles.get(id);
  }

  @Post()
  @RequirePermission('bundles.manage')
  create(@CurrentStaff() me: StaffContext, @Body() dto: BundleDto) {
    return this.bundles.create(me.staff.id, dto);
  }

  @Put(':id')
  @RequirePermission('bundles.manage')
  update(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: BundleDto) {
    return this.bundles.update(me.staff.id, id, dto);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('bundles.manage')
  status(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: BundleStatusDto) {
    return this.bundles.setActive(me.staff.id, id, dto.active);
  }
}
