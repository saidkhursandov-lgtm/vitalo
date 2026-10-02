import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { CartModule } from './cart/cart.module';
import { CatalogModule } from './catalog/catalog.module';
import { DeliveryModule } from './delivery/delivery.module';
import { OrdersModule } from './orders/orders.module';
import { PrismaModule } from './prisma/prisma.module';
import { SettingsModule } from './settings/settings.service';
import { StaffModule } from './staff/staff.module';

// forRoot() loads .env into process.env synchronously, so JOBS_ENABLED from .env is visible below.
const config = ConfigModule.forRoot({ isGlobal: true });
// Background jobs (reservation expiry) are off when JOBS_ENABLED=false, e.g. in e2e tests.
const jobs = process.env.JOBS_ENABLED === 'false' ? [] : [ScheduleModule.forRoot()];

@Module({
  imports: [
    config,
    ...jobs,
    PrismaModule,
    SettingsModule,
    AuthModule,
    CatalogModule,
    DeliveryModule,
    CartModule,
    OrdersModule,
    StaffModule,
  ],
})
export class AppModule {}
