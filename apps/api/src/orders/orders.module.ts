import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { InventoryModule } from '../inventory/inventory.module';
import { LegalModule } from '../legal/legal.module';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderUnitsService } from './order-units.service';
import { CrossBorderService } from './cross-border.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { ReservationExpiryService } from './reservation-expiry.service';
import { BotInfoService } from './receipts';
import { AnalyticsModule } from '../analytics/analytics.module';
import { PromoModule } from '../promo/promo.module';

@Module({
  imports: [AuthModule, InventoryModule, DeliveryModule, LegalModule, AnalyticsModule, PromoModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderLifecycleService, OrderUnitsService, ReservationExpiryService, BotInfoService, CrossBorderService],
  exports: [OrdersService, OrderLifecycleService, OrderUnitsService, ReservationExpiryService, BotInfoService, CrossBorderService],
})
export class OrdersModule {}
