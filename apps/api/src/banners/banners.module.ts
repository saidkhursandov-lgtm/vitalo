import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignsService } from '../promo/campaigns.service';
import { PromoModule } from '../promo/promo.module';
import { isShown, MAX_BANNERS, toShopBanner, type BannerLang, type ShopBanner } from './banners';

@Injectable()
export class BannersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignsService,
  ) {}

  /**
   * What the home screen shows now, in order; an empty list = no banner block at all.
   * 3.7: running sales come first (the soonest end first); they do not count against the 5 banners.
   */
  async forShop(lang: BannerLang, now = new Date()): Promise<ShopBanner[]> {
    const rows = await this.prisma.home_banners.findMany({ orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }] });
    const sales: ShopBanner[] = (await this.campaigns.shopList(now)).map((c) => ({ id: `campaign-${c.id}`, kind: 'campaign', image_url: null, image_jpeg_url: null, link: { type: 'campaign', value: c.slug }, campaign: c }));
    return [
      ...sales,
      ...rows
        .filter((b) => isShown(b, now))
        .slice(0, MAX_BANNERS)
        .map((b) => toShopBanner(b, lang)),
    ];
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

@Module({ imports: [PromoModule], controllers: [BannersController], providers: [BannersService] })
export class BannersModule {}
