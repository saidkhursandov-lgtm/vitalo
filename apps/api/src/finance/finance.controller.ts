import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../staff/audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from '../staff/staff-auth';
import { MONTH_RE, type Channel } from './finance-math';
import { FinanceService } from './finance.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const textOrNull = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || null : value);
const MAX_UZS = 100_000_000_000;

export class AnalyticsQuery {
  @ApiProperty({ example: '2026-11-01' }) @IsDateString({ strict: true }) from!: string;
  @ApiProperty({ example: '2026-11-30' }) @IsDateString({ strict: true }) to!: string;
  @ApiPropertyOptional({ enum: ['yandex', 'vitalo'] }) @IsOptional() @IsIn(['yandex', 'vitalo']) channel?: Channel;
}

export class ExpensesQuery {
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) to?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() category_id?: string;
}

export class ExpenseDto {
  @ApiProperty({ example: '2026-11-05' }) @IsDateString({ strict: true }) spent_on!: string;
  @ApiProperty() @IsUUID() category_id!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(MAX_UZS) amount_uzs!: number;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(500) comment?: string | null;
}

export class ExpensePatchDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString({ strict: true }) spent_on?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() category_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(MAX_UZS) amount_uzs?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(textOrNull) @IsString() @MaxLength(500) comment?: string | null;
}

export class FinanceReasonDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(3) @MaxLength(300) reason!: string;
}

export class CategoryDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) name!: string;
}

export class CategoryPatchDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hidden?: boolean;
}

export class TaxRateDto {
  @ApiProperty({ example: '2026-12' }) @Matches(MONTH_RE) from_month!: string;
  @ApiProperty({ example: 1 }) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99.99) percent!: number;
}

export class PayTaxDto {
  @ApiProperty({ example: '2026-12-10' }) @IsDateString({ strict: true }) paid_on!: string;
  @ApiProperty() @IsInt() @Min(0) @Max(MAX_UZS) paid_amount_uzs!: number;
}

export class EmployeeDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty({ example: '2026-11' }) @Matches(MONTH_RE) start_month!: string;
  @ApiProperty({ example: 400000 }) @IsInt() @Min(0) @Max(MAX_UZS) amount_uzs!: number;
}

export class EmployeePatchDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(MAX_UZS) amount_uzs?: number;
  @ApiPropertyOptional({ description: 'С какого месяца действует новая сумма (по умолчанию текущий)' }) @IsOptional() @Matches(MONTH_RE) from_month?: string;
}

export class PaySalaryDto {
  @ApiProperty({ example: '2026-11' }) @Matches(MONTH_RE) month!: string;
  @ApiProperty({ example: '2026-12-10' }) @IsDateString({ strict: true }) paid_on!: string;
  @ApiProperty() @IsInt() @Min(0) @Max(MAX_UZS) amount_uzs!: number;
}

export class OrderFinanceDto {
  @ApiPropertyOptional({ description: 'Тестовый заказ: не попадает в аналитику, налог и сводки' }) @IsOptional() @IsBoolean() is_test?: boolean;
  @ApiPropertyOptional({ description: 'Реальные расходы на доставку (наши), сум' }) @IsOptional() @IsInt() @Min(0) @Max(MAX_UZS) own_delivery_cost_uzs?: number;
}

/** «ТЕСТ» and «Реальные расходы на доставку (наши)» of an order of either channel: admin only, every change audited. */
@Injectable()
export class OrderFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async update(staffId: string, channel: Channel, id: string, dto: OrderFinanceDto) {
    if (dto.is_test === undefined && dto.own_delivery_cost_uzs === undefined) throw new BadRequestException({ code: 'NOTHING_TO_CHANGE', message: 'Нечего менять' });
    const data = {
      ...(dto.is_test !== undefined && { is_test: dto.is_test }),
      ...(dto.own_delivery_cost_uzs !== undefined && { own_delivery_cost_uzs: BigInt(dto.own_delivery_cost_uzs) }),
    };
    return this.prisma.$transaction(async (tx) => {
      const before =
        channel === 'yandex'
          ? await tx.marketplace_orders.findUnique({ where: { id }, select: { is_test: true, own_delivery_cost_uzs: true } })
          : await tx.orders.findUnique({ where: { id }, select: { is_test: true, own_delivery_cost_uzs: true } });
      if (!before) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
      if (channel === 'yandex') await tx.marketplace_orders.update({ where: { id }, data });
      else await tx.orders.update({ where: { id }, data });
      await this.audit.log(
        {
          staffId,
          action: dto.is_test !== undefined && dto.is_test !== before.is_test ? (dto.is_test ? 'order.marked_test' : 'order.unmarked_test') : 'order.own_delivery_cost_changed',
          entityType: channel === 'yandex' ? 'marketplace_order' : 'order',
          entityId: id,
          before: { is_test: before.is_test, own_delivery_cost_uzs: Number(before.own_delivery_cost_uzs) },
          after: dto,
        },
        tx,
      );
      return { id, is_test: dto.is_test ?? before.is_test, own_delivery_cost_uzs: dto.own_delivery_cost_uzs ?? Number(before.own_delivery_cost_uzs) };
    });
  }
}

/** Stage 3: all money screens. Admin only (finance.manage is given to no other role). */
@ApiTags('staff: finance')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@RequirePermission('finance.manage')
@Controller('staff/finance')
export class FinanceController {
  constructor(
    private readonly finance: FinanceService,
    private readonly orderFinance: OrderFinanceService,
  ) {}

  @Get('analytics')
  analytics(@Query() q: AnalyticsQuery) {
    return this.finance.analytics(q);
  }

  // ---- orders: test flag and our delivery cost

  @Patch('orders/:id')
  order(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: OrderFinanceDto) {
    return this.orderFinance.update(me.staff.id, 'vitalo', id, dto);
  }

  @Patch('yandex-orders/:id')
  yandexOrder(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: OrderFinanceDto) {
    return this.orderFinance.update(me.staff.id, 'yandex', id, dto);
  }

  // ---- expenses

  @Get('expense-categories')
  categories() {
    return this.finance.categories();
  }

  @Post('expense-categories')
  addCategory(@CurrentStaff() me: StaffContext, @Body() dto: CategoryDto) {
    return this.finance.addCategory(me.staff.id, dto.name);
  }

  @Patch('expense-categories/:id')
  updateCategory(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CategoryPatchDto) {
    return this.finance.updateCategory(me.staff.id, id, dto);
  }

  @Delete('expense-categories/:id')
  deleteCategory(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.finance.deleteCategory(me.staff.id, id);
  }

  @Get('expenses')
  expenses(@Query() q: ExpensesQuery) {
    return this.finance.expenses(q);
  }

  @Post('expenses')
  addExpense(@CurrentStaff() me: StaffContext, @Body() dto: ExpenseDto) {
    return this.finance.addExpense(me.staff.id, dto);
  }

  @Patch('expenses/:id')
  updateExpense(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ExpensePatchDto) {
    return this.finance.updateExpense(me.staff.id, id, dto);
  }

  /** POST, not DELETE: the reason travels in the body. */
  @Post('expenses/:id/delete')
  @HttpCode(200)
  deleteExpense(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: FinanceReasonDto) {
    return this.finance.deleteExpense(me.staff.id, id, dto.reason);
  }

  // ---- tax

  @Get('tax')
  tax() {
    return this.finance.tax();
  }

  @Post('tax/rate')
  @HttpCode(200)
  taxRate(@CurrentStaff() me: StaffContext, @Body() dto: TaxRateDto) {
    return this.finance.setTaxRate(me.staff.id, dto.from_month, dto.percent);
  }

  @Post('tax/:month/pay')
  @HttpCode(200)
  payTax(@CurrentStaff() me: StaffContext, @Param('month') month: string, @Body() dto: PayTaxDto) {
    if (!MONTH_RE.test(month)) throw new BadRequestException({ code: 'BAD_MONTH', message: 'Месяц пишется как ГГГГ-ММ' });
    return this.finance.payTax(me.staff.id, month, dto.paid_on, dto.paid_amount_uzs);
  }

  // ---- payroll

  @Get('payroll')
  payroll() {
    return this.finance.payroll();
  }

  @Post('payroll/employees')
  addEmployee(@CurrentStaff() me: StaffContext, @Body() dto: EmployeeDto) {
    return this.finance.addEmployee(me.staff.id, dto);
  }

  @Patch('payroll/employees/:id')
  updateEmployee(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: EmployeePatchDto) {
    return this.finance.updateEmployee(me.staff.id, id, dto);
  }

  @Post('payroll/employees/:id/pay')
  @HttpCode(200)
  paySalary(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PaySalaryDto) {
    return this.finance.paySalary(me.staff.id, id, dto);
  }
}
