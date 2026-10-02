import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { StaffAuthService, StaffGuard } from './staff-auth';
import { StaffAuthController, StaffOrdersController } from './staff.controllers';

@Module({
  imports: [AuthModule, OrdersModule],
  controllers: [StaffAuthController, StaffOrdersController],
  providers: [StaffAuthService, StaffGuard],
})
export class StaffModule {}
