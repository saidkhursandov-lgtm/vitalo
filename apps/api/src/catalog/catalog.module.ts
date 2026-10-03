import { Module } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Module({ imports: [DeliveryModule], controllers: [CatalogController], providers: [CatalogService] })
export class CatalogModule {}
