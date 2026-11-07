import { MapsModule } from '../maps/maps.module';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { AdminLegalController, LegalModule } from '../legal/legal.module';
import { OrdersModule } from '../orders/orders.module';
import { OnlinePaymentsModule } from '../payments/online/online-payments.module';
import { AdminBannersController, AdminBannersService } from './admin-banners';
import { AdminBrandsController, AdminBrandsService } from './admin-brands';
import { AdminCustomersController, AdminCustomersService } from './admin-customers';
import { AdminDictionariesController, AdminDictionariesService } from './admin-dictionaries';
import { AdminInventoryController, AdminInventoryService } from './admin-inventory';
import { AdminOrdersController, AdminOrdersService } from './admin-orders';
import { AdminProductsController, AdminProductsService } from './admin-products';
import { AdminPurchasesController, AdminPurchasesService } from './admin-purchases';
import { AdminWaitlistController, AdminWaitlistService } from './admin-waitlist';
import { AdminPromoCodesController, AdminPromoCodesService } from './admin-promo-codes';
import { AdminCampaignsController, AdminCampaignsService } from './admin-campaigns';
import { PromoModule } from '../promo/promo.module';
import { PromoController, PromoService } from '../notifications/notification-centre';
import { AdminReceiptsController, BotReceiptsController, ReceiptsService } from './admin-receipts';
import { BotSecretGuard } from '../bot-internal/bot-internal.module';
import { AdminCompatController, BotCompatController, CompatController, CompatService } from '../compat/compat.service';
import { AdminKnowledgeController, KnowledgeService } from '../compat/knowledge.service';
import { AdminAiController, AiController, AiService } from '../compat/ai.service';
import { AI_MODEL, AnthropicModel } from '../compat/ai-client';
import { AdminSettingsController, AdminSettingsService, AuditController, StaffUsersController } from './admin-settings';
import { AuditService } from './audit.service';
import { DashboardController, DashboardService } from './dashboard';
import { AllOrdersController, AllOrdersService } from './admin-all-orders';
import { StaffAuthService, StaffGuard } from './staff-auth';
import { StaffAuthController } from './staff.controllers';
import { AnalyticsModule } from '../analytics/analytics.module';
import { InventoryModule } from '../inventory/inventory.module';
import { AdminReceivingController, AdminReceivingService } from '../receiving/admin-receiving';
import { AdminUnitsController, AdminUnitsService, PrintLabelsController } from '../receiving/admin-units';
import { UnitActionsController, UnitActionsService } from '../marketplace/unit-actions';
import { YandexOrdersController, YandexOrdersService } from '../marketplace/yandex-orders';
import { YANDEX_CLIENT_OPTIONS, YandexSyncService } from '../marketplace/yandex/yandex-sync';
import { SkuAliasesController, SkuAliasesService } from './sku-aliases';
import { YandexSyncController, YandexWebhookController } from '../marketplace/yandex/yandex-sync.controller';
import { FinanceController, OrderFinanceService } from '../finance/finance.controller';
import { FinanceRemindersService } from '../finance/finance-reminders.service';
import { FinanceService } from '../finance/finance.service';
import { OrderLabelController, OrderLabelService, PrintOrderLabelController } from './order-label';

/**
 * Admin panel API (/api/staff/*). Every controller is behind StaffGuard + role permissions, except
 * PrintLabelsController (/api/print/labels) and PrintOrderLabelController (/api/print/order-label): they accept only a
 * signed print ticket issued by a signed-in employee, and
 * YandexWebhookController (/api/yandex/notifications/<secret>): off by default, secret path + Yandex networks only.
 */
@Module({
  imports: [AuthModule, OrdersModule, DeliveryModule, LegalModule, AnalyticsModule, InventoryModule, OnlinePaymentsModule, PromoModule, MapsModule],
  controllers: [
    StaffAuthController,
    AdminBannersController,
    AdminBrandsController,
    DashboardController,
    AllOrdersController,
    AdminOrdersController,
    OrderLabelController,
    PrintOrderLabelController,
    AdminProductsController,
    AdminInventoryController,
    AdminCustomersController,
    AdminDictionariesController,
    AdminPurchasesController,
    AdminReceivingController,
    AdminUnitsController,
    PrintLabelsController,
    UnitActionsController,
    YandexOrdersController,
    YandexSyncController,
    SkuAliasesController,
    YandexWebhookController,
    FinanceController,
    AdminSettingsController,
    StaffUsersController,
    AuditController,
    AdminLegalController,
    AdminWaitlistController,
    AdminPromoCodesController,
    AdminCampaignsController,
    PromoController,
    AdminReceiptsController,
    BotReceiptsController,
    CompatController,
    AdminCompatController,
    BotCompatController,
    AiController,
    AdminAiController,
    AdminKnowledgeController,
  ],
  providers: [
    AdminBannersService,
    AdminBrandsService,
    AdminPromoCodesService,
    AdminCampaignsService,
    StaffAuthService,
    StaffGuard,
    AuditService,
    DashboardService,
    AllOrdersService,
    AdminOrdersService,
    OrderLabelService,
    AdminProductsService,
    AdminInventoryService,
    AdminCustomersService,
    AdminDictionariesService,
    AdminPurchasesService,
    AdminReceivingService,
    AdminUnitsService,
    UnitActionsService,
    YandexOrdersService,
    YandexSyncService,
    SkuAliasesService,
    FinanceService,
    OrderFinanceService,
    FinanceRemindersService,
    // real fetch and pauses; e2e tests override it with a fake fed by fixtures (never a real request to Yandex)
    { provide: YANDEX_CLIENT_OPTIONS, useValue: {} },
    AdminSettingsService,
    AdminWaitlistService,
    PromoService,
    ReceiptsService,
    CompatService,
    KnowledgeService,
    AiService,
    { provide: AI_MODEL, useClass: AnthropicModel },
    BotSecretGuard,
  ],
})
export class StaffModule {}
