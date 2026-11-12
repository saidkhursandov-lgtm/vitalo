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
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import type { home_banners } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { memoryStorage } from 'multer';
import { BANNER_HEIGHT, BANNER_LINK_TYPES, BANNER_WIDTH, MAX_BANNERS, storeBannerImage, type BannerLang, type BannerLinkType } from '../banners/banners';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage';
import { detectImage, MAX_PHOTO_BYTES } from './admin-products';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

export class UpdateBannerDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ enum: BANNER_LINK_TYPES, nullable: true, description: 'Куда ведёт нажатие; null — никуда' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(BANNER_LINK_TYPES)
  link_type?: BannerLinkType | null;
  @ApiPropertyOptional({ nullable: true, description: 'id товара, slug категории или название бренда' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  link_value?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Показывать с (дата и время ISO)' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  starts_at?: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Показывать по (дата и время ISO)' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  ends_at?: string | null;
}

export class ReorderBannersDto {
  @IsArray() @ArrayMaxSize(MAX_BANNERS) @IsUUID('all', { each: true }) ids!: string[];
}

const LANGS: BannerLang[] = ['ru', 'uz'];
const imageFields = (lang: BannerLang) => (lang === 'uz' ? (['image_uz_url', 'image_uz_jpeg'] as const) : (['image_ru_url', 'image_ru_jpeg'] as const));

/** Настройки → Главная → Баннеры: up to 5, on/off, order, RU / UZ pictures, a link, show-from / show-until dates. */
@Injectable()
export class AdminBannersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  list() {
    return this.prisma.home_banners.findMany({ orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }] });
  }

  /** Аудит 4.3: shows and taps of each banner over the last 30 days (customers who saw it / tapped, once per session). */
  async stats(now = new Date()): Promise<Map<string, { views: number; clicks: number }>> {
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const rows = await this.prisma.$queryRaw<{ banner_id: string; event: string; n: bigint }[]>`
      SELECT props->>'banner_id' AS banner_id, event, COUNT(*) AS n
      FROM analytics_events
      WHERE event IN ('home_banner_view', 'home_banner_click') AND created_at >= ${since} AND props ? 'banner_id'
      GROUP BY 1, 2`;
    const out = new Map<string, { views: number; clicks: number }>();
    for (const x of rows) {
      const s = out.get(x.banner_id) ?? { views: 0, clicks: 0 };
      if (x.event === 'home_banner_view') s.views = Number(x.n);
      else s.clicks = Number(x.n);
      out.set(x.banner_id, s);
    }
    return out;
  }

  private async get(id: string): Promise<home_banners> {
    const b = await this.prisma.home_banners.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Banner not found');
    return b;
  }

  /** A new picture banner goes to the end of the list, switched off until a picture is uploaded. */
  async create(staffId: string) {
    const rows = await this.list();
    if (rows.length >= MAX_BANNERS) {
      throw new ConflictException({ code: 'BANNERS_LIMIT', message: `Не больше ${MAX_BANNERS} баннеров. Выключите или удалите лишний.` });
    }
    const b = await this.prisma.home_banners.create({
      data: { kind: 'image', enabled: false, sort_order: rows.reduce((m, r) => Math.max(m, r.sort_order), 0) + 1 },
    });
    await this.audit.log({ staffId, action: 'banner.created', entityType: 'home_banner', entityId: b.id, after: b });
    return b;
  }

  async update(staffId: string, id: string, dto: UpdateBannerDto) {
    const before = await this.get(id);
    const next = { ...before, ...dto, starts_at: dto.starts_at === undefined ? before.starts_at : dto.starts_at && new Date(dto.starts_at), ends_at: dto.ends_at === undefined ? before.ends_at : dto.ends_at && new Date(dto.ends_at) };
    if (next.enabled && before.kind === 'image' && !before.image_ru_url && !before.image_uz_url) {
      throw new BadRequestException({ code: 'BANNER_IMAGE_REQUIRED', message: 'Сначала загрузите картинку (RU или UZ), потом включайте баннер.' });
    }
    if (next.starts_at && next.ends_at && next.starts_at > next.ends_at) {
      throw new BadRequestException({ code: 'BANNER_DATES', message: 'Дата «по» раньше даты «с».' });
    }
    const link = next.link_type ? await this.checkLink(next.link_type as BannerLinkType, next.link_value) : null;
    const b = await this.prisma.home_banners.update({
      where: { id },
      data: { enabled: next.enabled, starts_at: next.starts_at, ends_at: next.ends_at, link_type: link?.type ?? null, link_value: link?.value ?? null },
    });
    await this.audit.log({ staffId, action: 'banner.updated', entityType: 'home_banner', entityId: id, before, after: b });
    return b;
  }

  /** The link must point to something that exists (an archived product or a missing brand would lead to an empty page). */
  private async checkLink(type: BannerLinkType, value: string | null | undefined) {
    const v = value?.trim();
    const bad = () => new BadRequestException({ code: 'BANNER_LINK_INVALID', message: 'Ссылка баннера: такой товар, категория или бренд не найдены.' });
    if (!v) throw bad();
    if (type === 'product') {
      const ok = /^[0-9a-f-]{36}$/i.test(v) && (await this.prisma.products.count({ where: { id: v, status: 'active' } }));
      if (!ok) throw bad();
    } else if (type === 'category') {
      if (!(await this.prisma.categories.count({ where: { slug: v } }))) throw bad();
    } else if (!(await this.prisma.products.count({ where: { brand: v, status: 'active' } }))) {
      throw bad();
    }
    return { type, value: v };
  }

  /** The full list of ids in the new order (arrows or drag and drop in the admin panel). */
  async reorder(staffId: string, ids: string[]) {
    const rows = await this.list();
    if (ids.length !== rows.length || new Set(ids).size !== ids.length || rows.some((r) => !ids.includes(r.id))) {
      throw new BadRequestException({ code: 'BANNER_ORDER_INVALID', message: 'Передайте все баннеры, каждый один раз.' });
    }
    await this.prisma.$transaction(ids.map((id, i) => this.prisma.home_banners.update({ where: { id }, data: { sort_order: i + 1 } })));
    await this.audit.log({ staffId, action: 'banner.reordered', entityType: 'home_banner', before: rows.map((r) => r.id), after: ids });
    return this.list();
  }

  async uploadImage(staffId: string, id: string, lang: BannerLang, file: Pick<Express.Multer.File, 'buffer'> | undefined) {
    const before = await this.get(id);
    if (before.kind !== 'image') throw new BadRequestException({ code: 'BANNER_NOT_IMAGE', message: 'У этого баннера нет картинки: его рисует магазин.' });
    if (!file) throw new BadRequestException({ code: 'FILE_REQUIRED', message: 'Send the image in the "file" field' });
    if (!detectImage(file.buffer)) throw new BadRequestException({ code: 'UNSUPPORTED_IMAGE', message: 'Только JPG, PNG или WebP' });
    const stored = await storeBannerImage(this.storage, id, lang, file.buffer).catch(() => {
      throw new BadRequestException({ code: 'UNSUPPORTED_IMAGE', message: 'Картинку не удалось прочитать' });
    });
    const [urlField, jpegField] = imageFields(lang);
    const b = await this.prisma.home_banners.update({ where: { id }, data: { [urlField]: stored.url, [jpegField]: stored.jpeg } });
    await this.removeFiles(before[urlField], before[jpegField]);
    await this.audit.log({ staffId, action: 'banner.image_uploaded', entityType: 'home_banner', entityId: id, after: { lang, url: stored.url } });
    return b;
  }

  /** Without any picture a picture banner is switched off (nothing to show). */
  async removeImage(staffId: string, id: string, lang: BannerLang) {
    const before = await this.get(id);
    const [urlField, jpegField] = imageFields(lang);
    const other = imageFields(lang === 'uz' ? 'ru' : 'uz')[0];
    const b = await this.prisma.home_banners.update({
      where: { id },
      data: { [urlField]: null, [jpegField]: null, ...(before.kind === 'image' && !before[other] && { enabled: false }) },
    });
    await this.removeFiles(before[urlField], before[jpegField]);
    await this.audit.log({ staffId, action: 'banner.image_removed', entityType: 'home_banner', entityId: id, before: { lang, url: before[urlField] } });
    return b;
  }

  /** Only picture banners are deleted; the two built-in ones can only be switched off. */
  async remove(staffId: string, id: string) {
    const before = await this.get(id);
    if (before.kind !== 'image') throw new BadRequestException({ code: 'BANNER_BUILT_IN', message: 'Этот баннер можно только выключить.' });
    await this.prisma.home_banners.delete({ where: { id } });
    for (const lang of LANGS) {
      const [u, j] = imageFields(lang);
      await this.removeFiles(before[u], before[j]);
    }
    await this.audit.log({ staffId, action: 'banner.deleted', entityType: 'home_banner', entityId: id, before });
    return this.list();
  }

  private async removeFiles(...urls: (string | null)[]) {
    for (const u of urls) if (u) await this.storage.remove(u).catch(() => undefined);
  }
}

@ApiTags('staff: settings')
@ApiBearerAuth()
@UseGuards(StaffGuard)
// D-53 (D-22): the marketer changes home banners without the admin
@RequirePermission('marketing.content')
@Controller('staff/settings/banners')
export class AdminBannersController {
  constructor(private readonly banners: AdminBannersService) {}

  @Get()
  list() {
    return Promise.all([this.banners.list(), this.banners.stats()]).then(([items, stats]) => ({
      items: items.map((b) => ({ ...b, stats: stats.get(b.id) ?? { views: 0, clicks: 0 } })),
      max: MAX_BANNERS,
      recommended: { width: BANNER_WIDTH, height: BANNER_HEIGHT },
    }));
  }

  @Post()
  create(@CurrentStaff() me: StaffContext) {
    return this.banners.create(me.staff.id);
  }

  @Put('order')
  reorder(@CurrentStaff() me: StaffContext, @Body() dto: ReorderBannersDto) {
    return this.banners.reorder(me.staff.id, dto.ids);
  }

  @Patch(':id')
  update(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateBannerDto) {
    return this.banners.update(me.staff.id, id, dto);
  }

  @Post(':id/image/:lang')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } }))
  upload(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('lang') lang: string, @UploadedFile() file?: Express.Multer.File) {
    return this.banners.uploadImage(me.staff.id, id, parseLang(lang), file);
  }

  @Delete(':id/image/:lang')
  removeImage(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('lang') lang: string) {
    return this.banners.removeImage(me.staff.id, id, parseLang(lang));
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.banners.remove(me.staff.id, id);
  }
}

function parseLang(lang: string): BannerLang {
  if (lang !== 'ru' && lang !== 'uz') throw new BadRequestException({ code: 'BAD_LANG', message: 'Language is ru or uz' });
  return lang;
}
