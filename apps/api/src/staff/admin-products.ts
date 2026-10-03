import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
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
import { Prisma, ProductStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { randomUUID } from 'crypto';
import { memoryStorage } from 'multer';
import { PageQuery } from '../catalog/catalog.dto';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

const PAGE_SIZE = 50;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Optional texts: "" means "clear the field". */
const textOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

const TEXT_FIELDS = [
  'name_uz',
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
}

export class ProductPatch extends PartialType(ProductInput) {}

export class StaffProductsQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'SKU, название или бренд' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional({ enum: ProductStatus }) @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
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

function toAdminProduct(p: ProductRow) {
  const { categories, media, inventory, price_uzs, old_price_uzs, cost_uzs, ...rest } = p;
  return {
    ...rest,
    price_uzs: Number(price_uzs),
    old_price_uzs: old_price_uzs == null ? null : Number(old_price_uzs),
    cost_uzs: cost_uzs == null ? null : Number(cost_uzs),
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
      ...(q.q && {
        OR: [
          { sku: { contains: q.q, mode: 'insensitive' } },
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
        include: { inventory: true, media: { where: { is_main: true }, take: 1 } },
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
        image_url: p.media[0]?.url ?? null,
        actual_qty: p.inventory.reduce((s, i) => s + i.actual_qty, 0),
        available_qty: p.inventory.reduce((s, i) => s + i.actual_qty - i.reserved_qty, 0),
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
      const p = await tx.products.create({ data: this.toData(data) as Prisma.productsUncheckedCreateInput });
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
      const after = await tx.products.update({ where: { id }, data: this.toData(data) });
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

    const url = await this.storage.save(`products/${id}/${randomUUID()}.${kind.ext}`, file.buffer, kind.mime);
    const hasMain = product.media.some((m) => m.is_main && m.media_type === 'image');
    const media = await this.prisma.product_media.create({
      data: {
        product_id: id,
        media_type: 'image',
        url,
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
    await this.storage.remove(media.url);
    return this.get(id);
  }

  private toData(d: Omit<ProductPatch, 'category_ids'>): Prisma.productsUncheckedUpdateInput {
    const data: Record<string, unknown> = { ...d };
    for (const k of ['price_uzs', 'old_price_uzs', 'cost_uzs'] as const) {
      if (d[k] !== undefined) data[k] = d[k] === null ? null : BigInt(d[k]!);
    }
    for (const k of TEXT_FIELDS) if (d[k] === '') data[k] = null;
    return data;
  }

  private async assertCategories(tx: Prisma.TransactionClient, ids?: string[]) {
    if (!ids?.length) return;
    const found = await tx.categories.count({ where: { id: { in: ids } } });
    if (found !== new Set(ids).size) throw new BadRequestException({ code: 'UNKNOWN_CATEGORY', message: 'Unknown category id' });
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
  list(@Query() q: StaffProductsQuery) {
    return this.products.list(q);
  }

  @Get(':id')
  @RequirePermission('products.view')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.products.get(id);
  }

  @Post()
  @RequirePermission('products.edit')
  create(@CurrentStaff() me: StaffContext, @Body() dto: ProductInput) {
    return this.products.create(me.staff.id, dto);
  }

  @Patch(':id')
  @RequirePermission('products.edit')
  update(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ProductPatch) {
    return this.products.update(me.staff.id, id, dto);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission('products.edit')
  archive(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.products.update(me.staff.id, id, { status: 'archived' });
  }

  @Post(':id/photos')
  @RequirePermission('products.edit')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } }))
  addPhoto(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @UploadedFile() file?: Express.Multer.File) {
    return this.products.addPhoto(me.staff.id, id, file);
  }

  @Post(':id/photos/:mediaId/main')
  @HttpCode(200)
  @RequirePermission('products.edit')
  setMain(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('mediaId', new ParseUUIDPipe()) mediaId: string) {
    return this.products.setMainPhoto(me.staff.id, id, mediaId);
  }

  @Delete(':id/photos/:mediaId')
  @RequirePermission('products.edit')
  removePhoto(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('mediaId', new ParseUUIDPipe()) mediaId: string) {
    return this.products.removePhoto(me.staff.id, id, mediaId);
  }
}
