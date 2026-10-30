import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { Prisma, ProductStatus, StaffRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { randomUUID } from 'crypto';
import { memoryStorage } from 'multer';
import { PageQuery } from '../catalog/catalog.dto';
import { HALAL_VEGE, type HalalVege } from '../catalog/product.mapper';
import { DICTIONARY_COLUMNS, DICTIONARY_KINDS, matchKey } from '../dictionaries/dictionary-names';
import { dictionaryTable } from './admin-dictionaries';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage';
import { imageFiles, storeProductImage } from '../storage/image-processing';
import { AuditService } from './audit.service';
import { can } from './permissions';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

const PAGE_SIZE = 50;
/** Upload limit for the original (it is compressed right away and not kept). */
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Optional texts: "" means "clear the field". */
const textOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

const TEXT_FIELDS = [
  'name_uz',
  'short_name_ru',
  'short_name_uz',
  'country',
  'form',
  'short_description_ru',
  'short_description_uz',
  'composition_ru',
  'composition_uz',
  'nutrition_ru',
  'nutrition_uz',
  'directions_ru',
  'directions_uz',
  'warnings_ru',
  'warnings_uz',
  'search_keywords',
  'substance_form_ru',
  'substance_form_uz',
  'shell_ru',
  'shell_uz',
  'halal_vege_source',
  'doctor_verdict_ru',
  'doctor_verdict_uz',
  'intake_memo_ru',
  'intake_memo_uz',
  'admin_note',
] as const;

export class ProductInput {
  @ApiProperty({ example: 'VTL-OMEGA3' })
  @Transform(trim)
  @Matches(/^[A-Za-z0-9._-]{2,50}$/, { message: 'sku: 2-50 latin letters, digits, . _ -' })
  sku!: string;

  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) name_ru!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(100) brand!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) manufacturer!: string;
  @ApiProperty({ description: 'Цена, сум' }) @IsInt() @Min(0) price_uzs!: number;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsInt() @Min(0) old_price_uzs?: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Себестоимость (видна только в админке)' }) @IsOptional() @IsInt() @Min(0) cost_uzs?: number | null;
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @IsInt() @Min(0) min_stock?: number;
  @ApiPropertyOptional({ enum: ProductStatus }) @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) category_ids?: string[];

  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(200) name_uz?: string | null;
  @ApiPropertyOptional({ description: 'Короткое название для корзины, оформления и заказов (пусто — полное)' })
  @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(60) short_name_ru?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(60) short_name_uz?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(100) country?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(100) form?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(1000) short_description_ru?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(1000) short_description_uz?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(5000) composition_ru?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(5000) composition_uz?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(5000) nutrition_ru?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(5000) nutrition_uz?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(5000) directions_ru?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(5000) directions_uz?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(5000) warnings_ru?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(5000) warnings_uz?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(1000) search_keywords?: string | null;

  // 2.3: product card (release-2.3.md). Course days = pack_count / servings_per_day.
  @ApiPropertyOptional({ description: 'Форма вещества, напр. «Цитрат + B6»' }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(60) substance_form_ru?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(60) substance_form_uz?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Количество в банке' }) @IsOptional() @IsInt() @Min(1) @Max(10000) pack_count?: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Порций в день' }) @IsOptional() @IsInt() @Min(1) @Max(50) servings_per_day?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() std_bioavailability?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() std_tested?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() std_original?: boolean;
  @ApiPropertyOptional({ nullable: true, enum: HALAL_VEGE, description: 'Halal только с сертификатом, VEGE только по этикетке (D-32)' })
  @IsOptional() @IsIn([...HALAL_VEGE, null]) halal_vege?: HalalVege | null;
  @ApiPropertyOptional({ description: 'Оболочка, напр. «говяжий желатин»' }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(100) shell_ru?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(100) shell_uz?: string | null;
  @ApiPropertyOptional({ description: 'Откуда данные Halal/VEGE (только админка)' }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(300) halal_vege_source?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'На X% выгоднее Маркета, 0–50' }) @IsOptional() @IsInt() @Min(0) @Max(50) market_advantage_percent?: number | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(400) doctor_verdict_ru?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(400) doctor_verdict_uz?: string | null;
  @ApiPropertyOptional({ description: 'Памятка приёма (покупателю — с релиза 3)' }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(1000) intake_memo_ru?: string | null;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(1000) intake_memo_uz?: string | null;
  @ApiPropertyOptional({ description: 'Комментарий сотрудникам' }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(1000) admin_note?: string | null;

  // Stage 1.1: dictionary values. Their names are copied into brand / manufacturer / country / form.
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() brand_id?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() manufacturer_id?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() country_id?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsUUID() form_id?: string | null;

  // Stage 1.4: Yandex Market. Commission, payment fee and logistics need costs.view (admin).
  @ApiPropertyOptional({ nullable: true, description: 'Цена на Яндекс Маркете, сум' }) @IsOptional() @IsInt() @Min(0) yandex_price_uzs?: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Комиссия Яндекса, % (0–100)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  yandex_commission_percent?: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Платёжный сбор Яндекса (поручение на перевод платежа), % (0–100)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100)
  yandex_payment_fee_percent?: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'Логистика Яндекса за заказ, сум' }) @IsOptional() @IsInt() @Min(0) yandex_logistics_uzs?: number | null;
  /**
   * Required when yandex_price_uzs changes: «Вы уже изменили цену в Яндекс Маркете?».
   * true -> synchronized; false -> «требует синхронизации». Not stored itself.
   */
  @ApiPropertyOptional({ description: 'Ответ на «Вы уже изменили цену в Яндекс Маркете?» (обязателен, если цена Яндекса меняется)' })
  @IsOptional()
  @IsBoolean()
  yandex_price_already_changed?: boolean;
}

export class ProductPatch extends PartialType(ProductInput) {}

/** Stage 2B: short composition (admin and manager). Empty = not filled. Not printed on the 58×40 Physical ID label (S2B-8). */
export class ProductLabelDto {
  @ApiPropertyOptional({ nullable: true, maxLength: 300 }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(300) label_composition_ru?: string | null;
  @ApiPropertyOptional({ nullable: true, maxLength: 300 }) @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(300) label_composition_uz?: string | null;
}

export class StaffProductsQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'SKU, название или бренд' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional({ enum: ProductStatus }) @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
  @ApiPropertyOptional({ description: 'true — только товары, у которых цена Яндекса требует синхронизации' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  yandex_sync_needed?: boolean;
}

/** Real image type from the first bytes (the browser-provided mimetype can lie). */
export function detectImage(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

const productInclude = {
  categories: { select: { category_id: true } },
  media: { orderBy: [{ is_main: 'desc' }, { sort_order: 'asc' }] },
  inventory: { include: { warehouse: { select: { id: true, name: true } } } },
} satisfies Prisma.productsInclude;

type ProductRow = Prisma.productsGetPayload<{ include: typeof productInclude }>;

/** Finance of a product: purchase cost (stage 0) and Yandex commission, payment fee, logistics (stage 1). Admin only. */
export const COST_FIELDS = ['cost_uzs', 'yandex_commission_percent', 'yandex_payment_fee_percent', 'yandex_logistics_uzs'] as const;
/** Yandex price and its sync status: admin, manager, marketer (not warehouse). */
export const YANDEX_PRICE_FIELDS = ['yandex_price_uzs', 'yandex_price_sync_needed', 'yandex_price_sync_changed_at'] as const;

/** What an employee may see of a product: fields their role may not see are absent from the answer. */
export function forViewer<T extends object>(role: StaffRole, product: T): Partial<T> {
  const out = { ...product } as Record<string, unknown>;
  if (!can(role, 'costs.view')) for (const k of COST_FIELDS) delete out[k];
  if (!can(role, 'yandex.price.view')) for (const k of YANDEX_PRICE_FIELDS) delete out[k];
  return out as Partial<T>;
}

/** Writing finance fields needs costs.view too (products.edit alone is not enough). */
function assertCostWrite(role: StaffRole, dto: object) {
  const sent = COST_FIELDS.filter((k) => (dto as Record<string, unknown>)[k] !== undefined);
  if (sent.length && !can(role, 'costs.view')) {
    throw new ForbiddenException({ code: 'COST_FORBIDDEN', message: `Role ${role} cannot see or change: ${sent.join(', ')}` });
  }
}

const num = (v: bigint | Prisma.Decimal | null) => (v == null ? null : Number(v));

function toAdminProduct(p: ProductRow) {
  const {
    categories,
    media,
    inventory,
    price_uzs,
    old_price_uzs,
    cost_uzs,
    yandex_price_uzs,
    yandex_commission_percent,
    yandex_payment_fee_percent,
    yandex_logistics_uzs,
    ...rest
  } = p;
  return {
    ...rest,
    price_uzs: Number(price_uzs),
    old_price_uzs: num(old_price_uzs),
    cost_uzs: num(cost_uzs),
    yandex_price_uzs: num(yandex_price_uzs),
    yandex_commission_percent: num(yandex_commission_percent),
    yandex_payment_fee_percent: num(yandex_payment_fee_percent),
    yandex_logistics_uzs: num(yandex_logistics_uzs),
    category_ids: categories.map((c) => c.category_id),
    media: media.map((m) => ({ id: m.id, url: m.url, is_main: m.is_main, type: m.media_type, title: m.title })),
    stock: inventory.map((i) => ({
      warehouse: i.warehouse,
      actual_qty: i.actual_qty,
      reserved_qty: i.reserved_qty,
      available_qty: i.actual_qty - i.reserved_qty,
    })),
  };
}

@Injectable()
export class AdminProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async list(q: StaffProductsQuery) {
    const where: Prisma.productsWhereInput = {
      ...(q.status && { status: q.status }),
      ...(q.yandex_sync_needed && { yandex_price_sync_needed: true }),
      ...(q.q && {
        OR: [
          { sku: { contains: q.q, mode: 'insensitive' } },
          // an old code (alternative SKU) finds the product too
          { sku_aliases: { some: { alias_norm: { contains: q.q.trim().toUpperCase() } } } },
          { name_ru: { contains: q.q, mode: 'insensitive' } },
          { name_uz: { contains: q.q, mode: 'insensitive' } },
          { brand: { contains: q.q, mode: 'insensitive' } },
        ],
      }),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.products.count({ where }),
      this.prisma.products.findMany({
        where,
        orderBy: [{ status: 'asc' }, { name_ru: 'asc' }],
        skip: (q.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          inventory: true,
          media: { where: { is_main: true }, take: 1 },
          ...(q.q && { sku_aliases: { where: { alias_norm: { contains: q.q.trim().toUpperCase() } }, select: { alias: true }, take: 1 } }),
        },
      }),
    ]);
    return {
      items: rows.map((p) => ({
        id: p.id,
        sku: p.sku,
        name_ru: p.name_ru,
        brand: p.brand,
        price_uzs: Number(p.price_uzs),
        status: p.status,
        min_stock: p.min_stock,
        image_url: p.media[0]?.thumb_url ?? p.media[0]?.url ?? null,
        actual_qty: p.inventory.reduce((s, i) => s + i.actual_qty, 0),
        available_qty: p.inventory.reduce((s, i) => s + i.actual_qty - i.reserved_qty, 0),
        yandex_price_uzs: num(p.yandex_price_uzs),
        yandex_price_sync_needed: p.yandex_price_sync_needed,
        // found by an old code: «по старому SKU …» in the picker
        matched_alias: q.q && !p.sku.toUpperCase().includes(q.q.trim().toUpperCase()) ? ((p as { sku_aliases?: { alias: string }[] }).sku_aliases?.[0]?.alias ?? null) : null,
      })),
      page: q.page,
      page_size: PAGE_SIZE,
      total,
      total_pages: Math.ceil(total / PAGE_SIZE),
    };
  }

  async get(id: string) {
    const p = await this.prisma.products.findUnique({ where: { id }, include: productInclude });
    if (!p) throw new NotFoundException('Product not found');
    return toAdminProduct(p);
  }

  async create(staffId: string | null, dto: ProductInput) {
    const id = await this.write(async (tx) => {
      const { category_ids, ...data } = dto;
      await this.assertCategories(tx, category_ids);
      await this.applyDictionaries(tx, null, data as Record<string, unknown>);
      const p = await tx.products.create({ data: this.toData(this.applyYandexSync(null, data as Record<string, unknown>)) as Prisma.productsUncheckedCreateInput });
      if (category_ids?.length) await tx.product_categories.createMany({ data: category_ids.map((c) => ({ product_id: p.id, category_id: c })) });
      await this.audit.log({ staffId, action: 'product.created', entityType: 'product', entityId: p.id, after: { ...p, category_ids } }, tx);
      return p.id;
    });
    return this.get(id);
  }

  /** Includes archiving (status = archived). Products are never deleted (DB trigger forbids it too). */
  async update(staffId: string | null, id: string, dto: ProductPatch) {
    await this.write(async (tx) => {
      const before = await tx.products.findUnique({ where: { id }, include: { categories: true } });
      if (!before) throw new NotFoundException('Product not found');
      const { category_ids, ...data } = dto;
      await this.assertCategories(tx, category_ids);
      await this.applyDictionaries(tx, before, data as Record<string, unknown>);
      const after = await tx.products.update({ where: { id }, data: this.toData(this.applyYandexSync(before, data as Record<string, unknown>)) });
      if (category_ids) {
        await tx.product_categories.deleteMany({ where: { product_id: id } });
        await tx.product_categories.createMany({ data: category_ids.map((c) => ({ product_id: id, category_id: c })) });
      }
      const { categories, ...beforePlain } = before;
      await this.audit.log(
        {
          staffId,
          action: dto.status === 'archived' && before.status !== 'archived' ? 'product.archived' : 'product.updated',
          entityType: 'product',
          entityId: id,
          before: { ...beforePlain, category_ids: categories.map((c) => c.category_id) },
          after: { ...after, ...(category_ids && { category_ids }) },
        },
        tx,
      );
    });
    return this.get(id);
  }

  /** `title` keeps the original file name (the Excel import uses it to avoid adding the same photo twice). */
  async addPhoto(staffId: string | null, id: string, file: Pick<Express.Multer.File, 'buffer'> | undefined, title?: string) {
    if (!file) throw new BadRequestException({ code: 'FILE_REQUIRED', message: 'Send the image in the "file" field' });
    const kind = detectImage(file.buffer);
    if (!kind) throw new BadRequestException({ code: 'UNSUPPORTED_IMAGE', message: 'Only JPEG, PNG or WebP images' });
    const product = await this.prisma.products.findUnique({ where: { id }, include: { media: true } });
    if (!product) throw new NotFoundException('Product not found');

    // D2: main WebP up to 1200 px + 400 px thumbnail, JPEG fallbacks; the original is not stored.
    const stored = await storeProductImage(this.storage, id, file.buffer).catch(() => {
      throw new BadRequestException({ code: 'UNSUPPORTED_IMAGE', message: 'The image could not be read' });
    });
    const url = stored.url;
    const hasMain = product.media.some((m) => m.is_main && m.media_type === 'image');
    const media = await this.prisma.product_media.create({
      data: {
        product_id: id,
        media_type: 'image',
        ...stored,
        is_main: !hasMain,
        title: title ?? null,
        sort_order: product.media.reduce((m, x) => Math.max(m, x.sort_order), -1) + 1,
      },
    });
    await this.audit.log({ staffId, action: 'product.photo_added', entityType: 'product', entityId: id, after: { media_id: media.id, url } });
    return this.get(id);
  }

  async setMainPhoto(staffId: string | null, id: string, mediaId: string) {
    await this.write(async (tx) => {
      const media = await tx.product_media.findFirst({ where: { id: mediaId, product_id: id } });
      if (!media) throw new NotFoundException('Photo not found');
      await tx.product_media.updateMany({ where: { product_id: id }, data: { is_main: false } });
      await tx.product_media.update({ where: { id: mediaId }, data: { is_main: true } });
      await this.audit.log({ staffId, action: 'product.photo_main', entityType: 'product', entityId: id, after: { media_id: mediaId } }, tx);
    });
    return this.get(id);
  }

  /** Removes one photo (the product itself is never deleted). The next photo becomes main if needed. */
  async removePhoto(staffId: string, id: string, mediaId: string) {
    const media = await this.write(async (tx) => {
      const m = await tx.product_media.findFirst({ where: { id: mediaId, product_id: id } });
      if (!m) throw new NotFoundException('Photo not found');
      await tx.product_media.delete({ where: { id: mediaId } });
      if (m.is_main) {
        const next = await tx.product_media.findFirst({ where: { product_id: id, media_type: 'image' }, orderBy: { sort_order: 'asc' } });
        if (next) await tx.product_media.update({ where: { id: next.id }, data: { is_main: true } });
      }
      await this.audit.log({ staffId, action: 'product.photo_removed', entityType: 'product', entityId: id, before: { media_id: m.id, url: m.url } }, tx);
      return m;
    });
    for (const file of imageFiles(media)) await this.storage.remove(file);
    return this.get(id);
  }

  /** «Отметить синхронизированной»: the Yandex price is already the same on Yandex Market. */
  async markYandexSynced(staffId: string, id: string) {
    await this.write(async (tx) => {
      const before = await tx.products.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Product not found');
      if (!before.yandex_price_sync_needed) return;
      await tx.products.update({ where: { id }, data: { yandex_price_sync_needed: false } });
      await this.audit.log(
        {
          staffId,
          action: 'product.yandex_price_synced',
          entityType: 'product',
          entityId: id,
          before: { yandex_price_uzs: before.yandex_price_uzs, yandex_price_sync_needed: true },
          after: { yandex_price_uzs: before.yandex_price_uzs, yandex_price_sync_needed: false },
        },
        tx,
      );
    });
    return this.get(id);
  }

  /** Stage 2B: «Короткий состав для этикетки» RU / UZ. */
  async updateLabel(staffId: string, id: string, dto: ProductLabelDto) {
    await this.write(async (tx) => {
      const before = await tx.products.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Product not found');
      const data: Prisma.productsUpdateInput = {};
      if (dto.label_composition_ru !== undefined) data.label_composition_ru = dto.label_composition_ru;
      if (dto.label_composition_uz !== undefined) data.label_composition_uz = dto.label_composition_uz;
      await tx.products.update({ where: { id }, data });
      await this.audit.log(
        {
          staffId,
          action: 'product.label_updated',
          entityType: 'product',
          entityId: id,
          before: { label_composition_ru: before.label_composition_ru, label_composition_uz: before.label_composition_uz },
          after: data,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /**
   * Stage 1.1: a chosen dictionary value overwrites the product's text column with its name (the Mini App
   * reads the text). An archived value may stay on a product but cannot be chosen anew. A text changed without
   * a dictionary choice keeps the link only while it still names the same value.
   */
  private async applyDictionaries(tx: Prisma.TransactionClient, before: object | null, data: Record<string, unknown>) {
    const prev = (before ?? {}) as Record<string, unknown>;
    for (const kind of DICTIONARY_KINDS) {
      const cols = DICTIONARY_COLUMNS[kind];
      const chosen = data[cols.id];
      if (typeof chosen === 'string') {
        const entry = await dictionaryTable(tx, kind).findUnique({ where: { id: chosen } });
        if (!entry) throw new BadRequestException({ code: 'UNKNOWN_DICTIONARY_VALUE', message: `Unknown ${cols.label}` });
        if (entry.status === 'archived' && prev[cols.id] !== entry.id) {
          throw new ConflictException({ code: 'DICTIONARY_ARCHIVED', message: `«${entry.name_ru}» в архиве — выберите другое значение` });
        }
        data[cols.text] = entry.name_ru;
      } else if (chosen === undefined && data[cols.text] !== undefined && typeof prev[cols.id] === 'string') {
        const linked = await dictionaryTable(tx, kind).findUnique({ where: { id: prev[cols.id] as string } });
        const text = data[cols.text];
        if (!linked || typeof text !== 'string' || matchKey(linked.name_ru) !== matchKey(text)) data[cols.id] = null;
      }
    }
  }

  /**
   * Stage 1.4: when the Yandex price changes, the answer to «Вы уже изменили цену в Яндекс Маркете?» is required:
   * yes -> synchronized, no -> «требует синхронизации». The VITALO price (price_uzs) needs no such question.
   */
  private applyYandexSync(before: { yandex_price_uzs?: bigint | null } | null, d: Record<string, unknown>) {
    const { yandex_price_already_changed: answer, ...data } = d;
    if (data.yandex_price_uzs === undefined) return data;
    const next = data.yandex_price_uzs == null ? null : BigInt(data.yandex_price_uzs as number);
    const prev = before?.yandex_price_uzs ?? null;
    if (next === prev) return data;
    if (answer === undefined) {
      throw new BadRequestException({
        code: 'YANDEX_SYNC_ANSWER_REQUIRED',
        message: 'The Yandex price changes: send yandex_price_already_changed (true / false)',
      });
    }
    return { ...data, yandex_price_sync_needed: next !== null && answer === false, yandex_price_sync_changed_at: new Date() };
  }

  private toData(d: Record<string, unknown>): Prisma.productsUncheckedUpdateInput {
    const data: Record<string, unknown> = { ...d };
    for (const k of ['price_uzs', 'old_price_uzs', 'cost_uzs', 'yandex_price_uzs', 'yandex_logistics_uzs'] as const) {
      if (d[k] !== undefined) data[k] = d[k] === null ? null : BigInt(d[k] as number);
    }
    for (const k of TEXT_FIELDS) if (d[k] === '') data[k] = null;
    delete data.yandex_price_already_changed;
    return data;
  }

  private async assertCategories(tx: Prisma.TransactionClient, ids?: string[]) {
    if (!ids?.length) return;
    const found = await tx.categories.findMany({ where: { id: { in: ids } }, select: { tree_type: true, status: true } });
    if (found.length !== new Set(ids).size) throw new BadRequestException({ code: 'UNKNOWN_CATEGORY', message: 'Unknown category id' });
    // 2.2: several needs, but exactly one product type (hidden old types are not counted).
    if (found.filter((c) => c.tree_type === 'product_type' && c.status === 'active').length > 1) {
      throw new BadRequestException({ code: 'ONE_PRODUCT_TYPE', message: 'У товара может быть только один тип («По типу»).' });
    }
  }

  private async write<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: 'SKU_TAKEN', message: 'A product with this SKU already exists' });
      }
      throw e;
    }
  }
}

@ApiTags('staff: products')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/products')
export class AdminProductsController {
  constructor(private readonly products: AdminProductsService) {}

  @Get()
  @RequirePermission('products.view')
  async list(@CurrentStaff() me: StaffContext, @Query() q: StaffProductsQuery) {
    if (q.yandex_sync_needed && !can(me.staff.role, 'yandex.price.view')) q.yandex_sync_needed = undefined;
    const page = await this.products.list(q);
    return { ...page, items: page.items.map((i) => forViewer(me.staff.role, i)) };
  }

  @Get(':id')
  @RequirePermission('products.view')
  async get(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return forViewer(me.staff.role, await this.products.get(id));
  }

  @Post()
  @RequirePermission('products.edit')
  async create(@CurrentStaff() me: StaffContext, @Body() dto: ProductInput) {
    assertCostWrite(me.staff.role, dto);
    return forViewer(me.staff.role, await this.products.create(me.staff.id, dto));
  }

  @Patch(':id')
  @RequirePermission('products.edit')
  async update(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ProductPatch) {
    assertCostWrite(me.staff.role, dto);
    return forViewer(me.staff.role, await this.products.update(me.staff.id, id, dto));
  }

  @Post(':id/yandex-price-synced')
  @HttpCode(200)
  @RequirePermission('yandex.price.sync')
  async markYandexSynced(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return forViewer(me.staff.role, await this.products.markYandexSynced(me.staff.id, id));
  }

  @Patch(':id/label')
  @RequirePermission('products.label')
  async updateLabel(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ProductLabelDto) {
    return forViewer(me.staff.role, await this.products.updateLabel(me.staff.id, id, dto));
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission('products.edit')
  async archive(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return forViewer(me.staff.role, await this.products.update(me.staff.id, id, { status: 'archived' }));
  }

  @Post(':id/photos')
  @RequirePermission('products.edit')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } }))
  async addPhoto(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @UploadedFile() file?: Express.Multer.File) {
    return forViewer(me.staff.role, await this.products.addPhoto(me.staff.id, id, file));
  }

  @Post(':id/photos/:mediaId/main')
  @HttpCode(200)
  @RequirePermission('products.edit')
  async setMain(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('mediaId', new ParseUUIDPipe()) mediaId: string) {
    return forViewer(me.staff.role, await this.products.setMainPhoto(me.staff.id, id, mediaId));
  }

  @Delete(':id/photos/:mediaId')
  @RequirePermission('products.edit')
  async removePhoto(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('mediaId', new ParseUUIDPipe()) mediaId: string) {
    return forViewer(me.staff.role, await this.products.removePhoto(me.staff.id, id, mediaId));
  }
}
