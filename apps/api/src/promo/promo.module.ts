import { Module } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module';
import { CampaignsController, CampaignsService } from './campaigns.service';
import { PromoCodesService } from './promo.service';

/**
 * 3.3: the one discount calculation and promo codes (cart, checkout, orders; the admin section is in staff/).
 * 3.7: sales («Акции») — prices in the shop, the home slides, the sale page, the start message.
 */
@Module({ imports: [DeliveryModule], controllers: [CampaignsController], providers: [PromoCodesService, CampaignsService], exports: [PromoCodesService, CampaignsService] })
export class PromoModule {}
