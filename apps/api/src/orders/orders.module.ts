import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { InventoryModule } from '../inventory/inventory.module';
import { LegalModule } from '../legal/legal.module';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { ReservationExpiryService } from './reservation-expiry.service';

@Module({
  imports: [AuthModule, InventoryModule, DeliveryModule, LegalModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderLifecycleService, ReservationExpiryService],
  exports: [OrderLifecycleService, ReservationExpiryService],
})
export class OrdersModule {}
