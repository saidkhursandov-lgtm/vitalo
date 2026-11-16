import { Module } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module';
import { PromoModule } from '../promo/promo.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { PairService } from './pair.service';

@Module({ imports: [DeliveryModule, PromoModule], controllers: [CatalogController], providers: [CatalogService, PairService], exports: [PairService] })
export class CatalogModule {}
