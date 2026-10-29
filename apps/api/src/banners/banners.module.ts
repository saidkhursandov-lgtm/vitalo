import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { isShown, MAX_BANNERS, toShopBanner, type BannerLang, type ShopBanner } from './banners';

@Injectable()
export class BannersService {
  constructor(private readonly prisma: PrismaService) {}

  /** What the home screen shows now, in order; an empty list = no banner block at all. */
  async forShop(lang: BannerLang, now = new Date()): Promise<ShopBanner[]> {
    const rows = await this.prisma.home_banners.findMany({ orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }] });
    return rows
      .filter((b) => isShown(b, now))
      .slice(0, MAX_BANNERS)
      .map((b) => toShopBanner(b, lang));
  }
}

@ApiTags('catalog')
@Controller('catalog/banners')
export class BannersController {
  constructor(private readonly banners: BannersService) {}

  @Get()
  @ApiQuery({ name: 'lang', required: false, enum: ['ru', 'uz'], description: 'Язык картинки (если её нет — картинка другого языка)' })
  list(@Query('lang') lang?: string) {
    return this.banners.forShop(lang === 'uz' ? 'uz' : 'ru');
  }
}

@Module({ controllers: [BannersController], providers: [BannersService] })
export class BannersModule {}
