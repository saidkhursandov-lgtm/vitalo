import { Module } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module';
import { PromoCodesService } from './promo.service';

/** 3.3: the one discount calculation and promo codes (cart, checkout, orders; the admin section is in staff/). */
@Module({ imports: [DeliveryModule], providers: [PromoCodesService], exports: [PromoCodesService] })
export class PromoModule {}
