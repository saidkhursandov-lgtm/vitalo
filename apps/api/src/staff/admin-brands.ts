import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
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
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { randomUUID } from 'crypto';
import { memoryStorage } from 'multer';
import sharp from 'sharp';
import { availableQty } from '../catalog/product.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage';
import { detectImage, MAX_PHOTO_BYTES } from './admin-products';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

/** Logo: a square, stored as 400×400 WebP; a non-square picture is fitted inside on a transparent background. */
export const LOGO_SIZE = 400;

const trimOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);

export class UpdateBrandDto {
  @ApiPropertyOptional({ description: 'Адрес страницы бренда: латиница, цифры и «-», например now-foods' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'Адрес: только латинские буквы, цифры и «-» (например now-foods)' })
  @MaxLength(80)
  slug?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(trimOrNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(80) country_ru?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @Transform(trimOrNull) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(80) country_uz?: string | null;
  @ApiPropertyOptional({ nullable: true, description: '«Почему [бренд] в VITALO», RU' })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(2000)
  why_vitalo_ru?: string | null;
  @ApiPropertyOptional({ nullable: true, description: '«Почему [бренд] в VITALO», UZ' })
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(2000)
  why_vitalo_uz?: string | null;
  @ApiPropertyOptional({ description: 'Показывать в ленте «Проверенные бренды»' }) @IsOptional() @IsBoolean() show_in_showcase?: boolean;
  @ApiPropertyOptional({ description: 'Порядок в ленте: меньше — левее' }) @IsOptional() @IsInt() @Min(0) @Max(9999) sort_order?: number;
}

export async function storeBrandLogo(storage: FileStorage, brandId: string, input: Buffer) {
  const meta = await sharp(input, { failOn: 'error' }).metadata();
  const webp = await sharp(input, { failOn: 'error' })
    .rotate()
    .resize({ width: LOGO_SIZE, height: LOGO_SIZE, fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .webp({ quality: 85 })
    .toBuffer();
  const url = await storage.save(`brands/${brandId}/${randomUUID()}.webp`, webp, 'image/webp');
  const square = !!meta.width && !!meta.height && Math.abs(meta.width - meta.height) <= Math.max(meta.width, meta.height) * 0.05;
  return { url, square, width: meta.width ?? null, height: meta.height ?? null };
}

/** Админка → Бренды (2.2): the brand dictionary plus what the showcase and the brand page need. */
@Injectable()
export class AdminBrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /** D-61: `supplierId` — the supplier tab: brands with products bought there («none» — products without a supplier), only those products counted. */
  async list(supplierId?: string, hideTest = false) {
    const bySupplier: Prisma.productsWhereInput | undefined = supplierId
      ? { suppliers: supplierId === 'none' ? { none: {} } : { some: { supplier_id: supplierId } } }
      : undefined;
    const rows = await this.prisma.brands.findMany({
      // аудит 10.11, п. 1.5: тестовые бренды скрыты по умолчанию в админке
      where: { ...(bySupplier && { products: { some: bySupplier } }), ...(hideTest && { is_test: false }) },
      orderBy: [{ status: 'asc' }, { sort_order: 'asc' }, { name_ru: 'asc' }],
      include: { products: { where: bySupplier, select: { status: true, inventory: { select: { actual_qty: true, reserved_qty: true } } } } },
    });
    return rows.map(({ products, ...b }) => {
      const active = products.filter((p) => p.status === 'active');
      const inStock = active.filter((p) => availableQty(p.inventory) > 0).length;
      // What the shop shows: switched on, an address, and something to buy.
      const shown = b.status === 'active' && b.show_in_showcase && !!b.slug && inStock > 0;
      return { ...b, products: products.length, products_active: active.length, products_in_stock: inStock, shown_in_showcase: shown };
    });
  }

  private async get(id: string) {
    const b = await this.prisma.brands.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Brand not found');
    return b;
  }

  async update(staffId: string, id: string, dto: UpdateBrandDto) {
    const before = await this.get(id);
    try {
      const b = await this.prisma.brands.update({ where: { id }, data: dto });
      await this.audit.log({ staffId, action: 'brand.updated', entityType: 'brands', entityId: id, before, after: b });
      return b;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ code: 'BRAND_SLUG_TAKEN', message: `Адрес «${dto.slug}» уже занят другим брендом` });
      }
      throw e;
    }
  }

  async uploadLogo(staffId: string, id: string, file: Pick<Express.Multer.File, 'buffer'> | undefined) {
    const before = await this.get(id);
    if (!file) throw new BadRequestException({ code: 'FILE_REQUIRED', message: 'Send the image in the "file" field' });
    if (!detectImage(file.buffer)) throw new BadRequestException({ code: 'UNSUPPORTED_IMAGE', message: 'Только JPG, PNG или WebP' });
    const stored = await storeBrandLogo(this.storage, id, file.buffer).catch(() => {
      throw new BadRequestException({ code: 'UNSUPPORTED_IMAGE', message: 'Картинку не удалось прочитать' });
    });
    const b = await this.prisma.brands.update({ where: { id }, data: { logo_url: stored.url } });
    if (before.logo_url) await this.storage.remove(before.logo_url).catch(() => undefined);
    await this.audit.log({ staffId, action: 'brand.logo_uploaded', entityType: 'brands', entityId: id, after: { url: stored.url } });
    return { ...b, logo_square: stored.square, logo_source: { width: stored.width, height: stored.height } };
  }

  async removeLogo(staffId: string, id: string) {
    const before = await this.get(id);
    const b = await this.prisma.brands.update({ where: { id }, data: { logo_url: null } });
    if (before.logo_url) await this.storage.remove(before.logo_url).catch(() => undefined);
    await this.audit.log({ staffId, action: 'brand.logo_removed', entityType: 'brands', entityId: id, before: { url: before.logo_url } });
    return b;
  }

  /**
   * D-54 «Удалить»: erases the brand from everywhere (showcase, promotions, banners, logo). While the shop still has
   * products of the brand (not archived) it refuses: delete or move those first. Archived products keep the brand
   * name as text (orders show it) and lose only the link to the erased brand.
   */
  async remove(staffId: string, id: string) {
    const before = await this.get(id);
    await this.prisma.$transaction(async (tx) => {
      const live = await tx.products.count({ where: { brand_id: id, status: { not: 'archived' } } });
      if (live > 0) {
        throw new ConflictException({
          code: 'BRAND_HAS_PRODUCTS',
          message: `У бренда ${live} товар(ов). Сначала удалите их или поменяйте им бренд — потом удалите бренд.`,
          products: live,
        });
      }
      await tx.products.updateMany({ where: { brand_id: id }, data: { brand_id: null } });
      await tx.promotion_targets.deleteMany({ where: { brand_id: id } });
      await tx.home_banners.updateMany({
        where: { link_type: 'brand', link_value: { in: [before.name_ru, ...(before.slug ? [before.slug] : [])] } },
        data: { link_type: null, link_value: null },
      });
      await tx.$executeRaw`SELECT set_config('vitalo.allow_delete', 'on', true)`;
      await tx.brands.delete({ where: { id } });
      await tx.$executeRaw`SELECT set_config('vitalo.allow_delete', 'off', true)`;
      await this.audit.log({ staffId, action: 'brand.deleted', entityType: 'brands', entityId: id, before }, tx);
    });
    if (before.logo_url) await this.storage.remove(before.logo_url).catch(() => undefined);
    return { result: 'deleted' as const };
  }
}

@ApiTags('staff: brands')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@RequirePermission('settings.dictionaries')
@Controller('staff/brands')
export class AdminBrandsController {
  constructor(private readonly brands: AdminBrandsService) {}

  @Get()
  list(@Query('supplier_id') supplierId?: string, @Query('hide_test') hideTest?: string) {
    if (supplierId && !/^(none|[0-9a-f-]{36})$/i.test(supplierId)) throw new BadRequestException({ code: 'BAD_SUPPLIER', message: 'supplier_id: id or none' });
    return this.brands.list(supplierId || undefined, hideTest === 'true').then((items) => ({ items, logo: { width: LOGO_SIZE, height: LOGO_SIZE } }));
  }

  @Patch(':id')
  update(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateBrandDto) {
    return this.brands.update(me.staff.id, id, dto);
  }

  @Post(':id/logo')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } }))
  upload(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @UploadedFile() file?: Express.Multer.File) {
    return this.brands.uploadLogo(me.staff.id, id, file);
  }

  /** D-54 «Удалить» — admin only (the class permission is overridden here). */
  @Delete(':id')
  @RequirePermission('catalog.delete')
  remove(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.brands.remove(me.staff.id, id);
  }

  @Delete(':id/logo')
  removeLogo(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.brands.removeLogo(me.staff.id, id);
  }
}
