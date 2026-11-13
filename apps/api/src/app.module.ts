import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AddressesModule } from './addresses/addresses.module';
import { AuthModule } from './auth/auth.module';
import { BotInternalModule } from './bot-internal/bot-internal.module';
import { NotificationsModule } from './notifications/notifications.module';
import { NotificationCentreModule } from './notifications/notification-centre';
import { FavoritesModule } from './favorites/favorites.module';
import { CartModule } from './cart/cart.module';
import { CatalogModule } from './catalog/catalog.module';
import { DeliveryModule } from './delivery/delivery.module';
import { LegalModule } from './legal/legal.module';
import { OrdersModule } from './orders/orders.module';
import { PrismaModule } from './prisma/prisma.module';
import { SettingsModule } from './settings/settings.service';
import { StorageModule } from './storage/file-storage';
import { StaffModule } from './staff/staff.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { HealthModule } from './health/health';
import { OnlinePaymentsModule } from './payments/online/online-payments.module';
import { BannersModule } from './banners/banners.module';
import { WaitlistModule } from './waitlist/waitlist.module';
import { MapsModule } from './maps/maps.module';
import { BonusModule } from './bonus/bonus.service';
import { ReviewsModule } from './reviews/reviews.module';
import { ReturnsModule } from './returns/returns.module';

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
    BonusModule,
    ReviewsModule,
    ReturnsModule,
    StorageModule,
    NotificationsModule,
    NotificationCentreModule,
    AuthModule,
    CatalogModule,
    DeliveryModule,
    CartModule,
    OrdersModule,
    StaffModule,
    FavoritesModule,
    AddressesModule,
    BotInternalModule,
    LegalModule,
    AnalyticsModule,
    HealthModule,
    OnlinePaymentsModule,
    BannersModule,
    WaitlistModule,
    MapsModule,
  ],
})
export class AppModule {}
