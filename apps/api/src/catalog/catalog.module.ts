import { Module } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module';
import { PromoModule } from '../promo/promo.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { SitemapController } from './sitemap.controller';
import { PairService } from './pair.service';

@Module({ imports: [DeliveryModule, PromoModule], controllers: [CatalogController, SitemapController], providers: [CatalogService, PairService], exports: [PairService] })
export class CatalogModule {}
