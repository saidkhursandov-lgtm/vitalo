import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { marginWarnings, normalizePromoCode, PROMO_CODE_RE, PromoGuard } from '../promo/pricing';
import { PromoCodesService } from '../promo/promo.service';
import { SETTING_KEYS, SettingsService } from '../settings/settings.service';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

const TX = { maxWait: 10_000, timeout: 20_000 };
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Activations that count: the order holds it (reserved) or was paid (consumed). */
const HOLDING = ['reserved', 'consumed'] as const;
/** «Сгенерировать код»: no 0/O and 1/I, so a code read aloud or from a card is not mistyped. */
const GEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class PromoCodeDto {
  @ApiProperty({ example: 'VITALO10', description: 'Латиница и цифры, 3–32 знака; регистр не важен' })
  @Transform(({ value }) => (typeof value === 'string' ? normalizePromoCode(value) : value))
  @IsString()
  code!: string;

  @ApiProperty({ enum: ['percent', 'fixed', 'free_delivery'] }) @IsIn(['percent', 'fixed', 'free_delivery']) type!: 'percent' | 'fixed' | 'free_delivery';

  @ApiProperty({ description: '% (1–90) или сумма в сумах; для бесплатной доставки — 0' })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  value!: number;

  @ApiProperty({ enum: ['order', 'brand', 'product'], description: 'Вся корзина / бренды / товары' }) @IsIn(['order', 'brand', 'product']) scope!: 'order' | 'brand' | 'product';
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) product_ids?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) brand_ids?: string[];

  @ApiPropertyOptional({ description: 'Мин. сумма товаров, сум; пусто — без условия' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  min_order_uzs?: number | null;

  @ApiProperty() @IsBoolean() first_order_only!: boolean;

  @ApiPropertyOptional({ description: 'Лимит активаций всего; пусто — без лимита' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  global_limit?: number | null;

  @ApiProperty({ default: 1, description: 'Лимит на клиента' }) @IsInt() @Min(1) @Max(100) per_customer_limit!: number;
  @ApiProperty() @IsDateString() start_at!: string;
  @ApiProperty() @IsDateString() end_at!: string;
  @ApiProperty() @IsBoolean() active!: boolean;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(300) description_ru?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(300) description_uz?: string;
}

export class PromoStatusDto {
  @ApiProperty() @IsBoolean() active!: boolean;
}

export class PromoGuardDto {
  @ApiProperty({ description: 'Минимальная наценка над закупочной ценой, %' }) @IsInt() @Min(0) @Max(500) min_markup_pct!: number;
  @ApiProperty({ description: 'Максимальная скидка по промокоду для товара без закупочной цены, %' }) @IsInt() @Min(0) @Max(90) max_discount_pct!: number;
}

/**
 * 3.3: «Промокоды» in the admin panel. View: admin, manager, marketer; create / change / switch off: admin, marketer
 * (D-39 Б). A code is never deleted, only switched off. Margin protection settings: admin only (settings.manage).
 */
@Injectable()
export class AdminPromoCodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly promo: PromoCodesService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  /** Table: code, type, conditions, dates, status, used / limit, sum of discounts, revenue of paid orders with the code. */
  async list() {
    const rows = await this.prisma.promotions.findMany({
      where: { codes: { some: {} } },
      include: { codes: true, targets: { include: { product: { select: { sku: true } }, brand_ref: { select: { name_ru: true } } } } },
      orderBy: { created_at: 'desc' },
    });
    const usages = await this.prisma.promotion_usages.findMany({
      where: { promotion_id: { in: rows.map((r) => r.id) }, status: { in: [...HOLDING] }, order: { is_test: false } },
      select: { promotion_id: true, status: true, discount_uzs: true, order: { select: { total_uzs: true } } },
    });
    const now = new Date();
    return rows.map((p) => {
      const mine = usages.filter((u) => u.promotion_id === p.id);
      const paid = mine.filter((u) => u.status === 'consumed');
      return {
        ...this.view(p),
        state: p.status !== 'active' ? 'disabled' : p.start_at > now ? 'scheduled' : p.end_at <= now ? 'expired' : p.global_limit != null && mine.length >= p.global_limit ? 'exhausted' : 'active',
        used: mine.length,
        used_paid: paid.length,
        discount_total_uzs: mine.reduce((s, u) => s + Number(u.discount_uzs), 0),
        revenue_uzs: paid.reduce((s, u) => s + Number(u.order.total_uzs), 0),
      };
    });
  }

  async get(id: string) {
    const p = await this.prisma.promotions.findUnique({ where: { id }, include: { codes: true, targets: { include: { product: { select: { sku: true } }, brand_ref: { select: { name_ru: true } } } } } });
    if (!p || !p.codes.length) throw new NotFoundException('Promo code not found');
    const used = await this.prisma.promotion_usages.count({ where: { promotion_id: id, status: { in: [...HOLDING] } } });
    return { ...this.view(p), used };
  }

  async create(staffId: string, dto: PromoCodeDto) {
    this.check(dto);
    const id = await this.prisma.$transaction(async (tx) => {
      if (await tx.promo_codes.findUnique({ where: { code: dto.code } })) throw new ConflictException({ code: 'CODE_TAKEN', message: 'Такой код уже есть' });
      const p = await tx.promotions.create({ data: { ...this.fields(dto), name: dto.code } });
      await tx.promo_codes.create({ data: { promotion_id: p.id, code: dto.code, status: dto.active ? 'active' : 'disabled' } });
      await this.writeTargets(tx, p.id, dto);
      await this.audit.log({ staffId, action: 'promo_code.created', entityType: 'promotion', entityId: p.id, after: dto }, tx);
      return p.id;
    }, TX);
    return { ...(await this.get(id)), warnings: await this.marginCheck(dto) };
  }

  /** A used code keeps its text (orders and stats refer to it); everything else may change. */
  async update(staffId: string, id: string, dto: PromoCodeDto) {
    this.check(dto);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.promotions.findUnique({ where: { id }, include: { codes: true, targets: true } });
      if (!before || !before.codes.length) throw new NotFoundException('Promo code not found');
      const code = before.codes[0];
      if (code.code !== dto.code) {
        const used = await tx.promotion_usages.count({ where: { promotion_id: id } });
        if (used) throw new ConflictException({ code: 'CODE_USED', message: 'Код уже использовали в заказах — его текст менять нельзя' });
        if (await tx.promo_codes.findUnique({ where: { code: dto.code } })) throw new ConflictException({ code: 'CODE_TAKEN', message: 'Такой код уже есть' });
      }
      await tx.promotions.update({ where: { id }, data: { ...this.fields(dto), name: dto.code } });
      await tx.promo_codes.update({ where: { id: code.id }, data: { code: dto.code, status: dto.active ? 'active' : 'disabled' } });
      await tx.promotion_targets.deleteMany({ where: { promotion_id: id } }); // the code's own settings, rewritten as a whole
      await this.writeTargets(tx, id, dto);
      await this.audit.log({ staffId, action: 'promo_code.updated', entityType: 'promotion', entityId: id, before: this.view(before as never), after: dto }, tx);
    }, TX);
    return { ...(await this.get(id)), warnings: await this.marginCheck(dto) };
  }

  /** «Выключить» / «Включить»: never deleted. Orders already placed keep their discount. */
  async setActive(staffId: string, id: string, active: boolean) {
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.promotions.findUnique({ where: { id }, include: { codes: true } });
      if (!p || !p.codes.length) throw new NotFoundException('Promo code not found');
      await tx.promotions.update({ where: { id }, data: { status: active ? 'active' : 'disabled' } });
      await tx.promo_codes.updateMany({ where: { promotion_id: id }, data: { status: active ? 'active' : 'disabled' } });
      await this.audit.log({ staffId, action: active ? 'promo_code.enabled' : 'promo_code.disabled', entityType: 'promotion', entityId: id, before: { status: p.status }, after: { status: active ? 'active' : 'disabled' } }, tx);
    }, TX);
    return this.get(id);
  }

  /** A random free code: VIT + 5 characters. */
  async generate() {
    for (let i = 0; i < 20; i++) {
      const code = 'VIT' + Array.from({ length: 5 }, () => GEN_ALPHABET[randomInt(GEN_ALPHABET.length)]).join('');
      if (!(await this.prisma.promo_codes.findUnique({ where: { code } }))) return { code };
    }
    throw new ConflictException({ code: 'GENERATE_FAILED', message: 'Не удалось подобрать свободный код, попробуйте ещё раз' });
  }

  /**
   * «Предупреждение о защите маржи»: active products the code may touch where the discount on one jar would be cut
   * (cost + min markup, or the max discount without a cost) or where it does not apply (visible discount above 15%).
   */
  async marginCheck(dto: Pick<PromoCodeDto, 'type' | 'value' | 'scope' | 'product_ids' | 'brand_ids'>) {
    const where: Prisma.productsWhereInput = { status: 'active', ...(dto.scope === 'product' && { id: { in: dto.product_ids ?? [] } }), ...(dto.scope === 'brand' && { brand_id: { in: dto.brand_ids ?? [] } }) };
    const products = await this.prisma.products.findMany({ where, select: { id: true, sku: true, name_ru: true, short_name_ru: true, price_uzs: true }, orderBy: { sku: 'asc' } });
    const lines = await this.promo.pricingLines(this.prisma, products.map((p) => ({ product_id: p.id, qty: 1, unit_price_uzs: Number(p.price_uzs) })));
    const guard = await this.promo.guard();
    const warnings = marginWarnings(dto.type, dto.value, lines.map((l, i) => ({ ...l, sku: products[i].sku, name: products[i].short_name_ru || products[i].name_ru })), guard);
    return { guard, products_checked: products.length, items: warnings };
  }

  async guardSettings(): Promise<PromoGuard> {
    return this.promo.guard();
  }

  async setGuard(staffId: string, dto: PromoGuardDto): Promise<PromoGuard> {
    const before = await this.promo.guard();
    const value = { min_markup_pct: dto.min_markup_pct, max_discount_pct: dto.max_discount_pct };
    await this.prisma.$transaction(async (tx) => {
      await tx.settings.upsert({ where: { key: SETTING_KEYS.promoGuard }, create: { key: SETTING_KEYS.promoGuard, value }, update: { value } });
      await this.audit.log({ staffId, action: 'settings.promo_guard_updated', entityType: 'setting', entityId: null, before, after: value }, tx);
    });
    return this.settings.getOrDefault('promo_guard');
  }

  private check(dto: PromoCodeDto) {
    if (!PROMO_CODE_RE.test(dto.code)) throw new BadRequestException({ code: 'BAD_CODE', message: 'Код — латинские буквы и цифры, от 3 до 32 знаков' });
    if (dto.type === 'percent' && (dto.value < 1 || dto.value > 90)) throw new BadRequestException({ code: 'BAD_VALUE', message: 'Процент — от 1 до 90' });
    if (dto.type === 'fixed' && dto.value < 100) throw new BadRequestException({ code: 'BAD_VALUE', message: 'Сумма скидки — от 100 сум' });
    if (new Date(dto.end_at) <= new Date(dto.start_at)) throw new BadRequestException({ code: 'BAD_DATES', message: 'Дата окончания должна быть позже даты начала' });
    if (dto.scope === 'product' && !dto.product_ids?.length) throw new BadRequestException({ code: 'NO_TARGETS', message: 'Выберите товары' });
    if (dto.scope === 'brand' && !dto.brand_ids?.length) throw new BadRequestException({ code: 'NO_TARGETS', message: 'Выберите бренды' });
  }

  private fields(dto: PromoCodeDto) {
    return {
      type: dto.type,
      value: new Prisma.Decimal(dto.type === 'free_delivery' ? 0 : dto.value),
      scope_type: dto.scope,
      min_order_uzs: dto.min_order_uzs == null ? null : BigInt(dto.min_order_uzs),
      first_order_only: dto.first_order_only,
      global_limit: dto.global_limit ?? null,
      per_customer_limit: dto.per_customer_limit,
      start_at: new Date(dto.start_at),
      end_at: new Date(dto.end_at),
      status: dto.active ? ('active' as const) : ('disabled' as const),
      stacking_mode: 'exclusive' as const, // D-39: one code per order
      description_ru: dto.description_ru || null,
      description_uz: dto.description_uz || null,
    };
  }

  private async writeTargets(tx: Prisma.TransactionClient, promotionId: string, dto: PromoCodeDto) {
    if (dto.scope === 'product') {
      const ids = [...new Set(dto.product_ids)];
      if ((await tx.products.count({ where: { id: { in: ids } } })) !== ids.length) throw new BadRequestException({ code: 'UNKNOWN_PRODUCT', message: 'Some products do not exist' });
      await tx.promotion_targets.createMany({ data: ids.map((product_id) => ({ promotion_id: promotionId, product_id })) });
    } else if (dto.scope === 'brand') {
      const ids = [...new Set(dto.brand_ids)];
      if ((await tx.brands.count({ where: { id: { in: ids } } })) !== ids.length) throw new BadRequestException({ code: 'UNKNOWN_BRAND', message: 'Some brands do not exist' });
      await tx.promotion_targets.createMany({ data: ids.map((brand_id) => ({ promotion_id: promotionId, brand_id })) });
    }
  }

  private view(p: Prisma.promotionsGetPayload<{ include: { codes: true; targets: { include: { product: { select: { sku: true } }; brand_ref: { select: { name_ru: true } } } } } }>) {
    return {
      id: p.id,
      code: p.codes[0]?.code ?? p.name,
      type: p.type,
      value: Number(p.value),
      scope: p.scope_type,
      product_ids: p.targets.map((t) => t.product_id).filter((x): x is string => !!x),
      brand_ids: p.targets.map((t) => t.brand_id).filter((x): x is string => !!x),
      targets_label: p.targets.map((t) => t.product?.sku ?? t.brand_ref?.name_ru).filter(Boolean).join(', '),
      min_order_uzs: p.min_order_uzs == null ? null : Number(p.min_order_uzs),
      first_order_only: p.first_order_only,
      global_limit: p.global_limit,
      per_customer_limit: p.per_customer_limit ?? 1,
      start_at: p.start_at,
      end_at: p.end_at,
      active: p.status === 'active',
      description_ru: p.description_ru,
      description_uz: p.description_uz,
      created_at: p.created_at,
    };
  }
}

@ApiTags('staff: promo codes')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/promo-codes')
export class AdminPromoCodesController {
  constructor(private readonly promo: AdminPromoCodesService) {}

  @Get()
  @RequirePermission('promo.view')
  list() {
    return this.promo.list();
  }

  @Get('generate')
  @RequirePermission('promo.manage')
  generate() {
    return this.promo.generate();
  }

  @Get('settings')
  @RequirePermission('promo.view')
  guard() {
    return this.promo.guardSettings();
  }

  @Put('settings')
  @RequirePermission('settings.manage')
  setGuard(@CurrentStaff() me: StaffContext, @Body() dto: PromoGuardDto) {
    return this.promo.setGuard(me.staff.id, dto);
  }

  /** The form asks before saving: where the margin protection would cut the discount. */
  @Post('margin-check')
  @HttpCode(200)
  @RequirePermission('promo.manage')
  marginCheck(@Body() dto: PromoCodeDto) {
    return this.promo.marginCheck(dto);
  }

  @Get(':id')
  @RequirePermission('promo.view')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.promo.get(id);
  }

  @Post()
  @RequirePermission('promo.manage')
  create(@CurrentStaff() me: StaffContext, @Body() dto: PromoCodeDto) {
    return this.promo.create(me.staff.id, dto);
  }

  @Put(':id')
  @RequirePermission('promo.manage')
  update(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PromoCodeDto) {
    return this.promo.update(me.staff.id, id, dto);
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('promo.manage')
  setActive(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PromoStatusDto) {
    return this.promo.setActive(me.staff.id, id, dto.active);
  }
}
