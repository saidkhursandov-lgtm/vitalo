import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeliveryModule } from '../delivery/delivery.module';
import { AdminLegalController, LegalModule } from '../legal/legal.module';
import { OrdersModule } from '../orders/orders.module';
import { AdminCustomersController, AdminCustomersService } from './admin-customers';
import { AdminDictionariesController, AdminDictionariesService } from './admin-dictionaries';
import { AdminInventoryController, AdminInventoryService } from './admin-inventory';
import { AdminOrdersController, AdminOrdersService } from './admin-orders';
import { AdminProductsController, AdminProductsService } from './admin-products';
import { AdminPurchasesController, AdminPurchasesService } from './admin-purchases';
import { AdminSettingsController, AdminSettingsService, AuditController, StaffUsersController } from './admin-settings';
import { AuditService } from './audit.service';
import { DashboardController, DashboardService } from './dashboard';
import { StaffAuthService, StaffGuard } from './staff-auth';
import { StaffAuthController } from './staff.controllers';
import { AnalyticsModule } from '../analytics/analytics.module';
import { InventoryModule } from '../inventory/inventory.module';
import { AdminReceivingController, AdminReceivingService } from '../receiving/admin-receiving';
import { AdminUnitsController, AdminUnitsService, PrintLabelsController } from '../receiving/admin-units';
import { UnitActionsController, UnitActionsService } from '../marketplace/unit-actions';
import { YandexOrdersController, YandexOrdersService } from '../marketplace/yandex-orders';

/**
 * Admin panel API (/api/staff/*). Every controller is behind StaffGuard + role permissions, except
 * PrintLabelsController (/api/print/labels): it accepts only a signed print ticket issued by a signed-in employee.
 */
@Module({
  imports: [AuthModule, OrdersModule, DeliveryModule, LegalModule, AnalyticsModule, InventoryModule],
  controllers: [
    StaffAuthController,
    DashboardController,
    AdminOrdersController,
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
    AdminSettingsController,
    StaffUsersController,
    AuditController,
    AdminLegalController,
  ],
  providers: [
    StaffAuthService,
    StaffGuard,
    AuditService,
    DashboardService,
    AdminOrdersService,
    AdminProductsService,
    AdminInventoryService,
    AdminCustomersService,
    AdminDictionariesService,
    AdminPurchasesService,
    AdminReceivingService,
    AdminUnitsService,
    UnitActionsService,
    YandexOrdersService,
    AdminSettingsService,
  ],
})
export class StaffModule {}
