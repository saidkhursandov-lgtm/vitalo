import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { CancelOrderDto, CreateOrderDto, ListOrdersQuery, OrderPreviewDto, ReportPaymentDto } from './orders.dto';
import { OrdersService } from './orders.service';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

@ApiTags('orders')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('preview')
  @HttpCode(200)
  preview(@CurrentAuth() auth: AuthContext, @Body() dto: OrderPreviewDto) {
    return this.orders.preview(auth.user.id, dto);
  }

  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Один ключ (например UUID) на одну попытку оформления' })
  async create(
    @CurrentAuth() auth: AuthContext,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Header Idempotency-Key (8-128 chars) is required' });
    }
    const { order, replayed } = await this.orders.create(auth.user.id, key, dto);
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return order;
  }

  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() q: ListOrdersQuery) {
    return this.orders.list(auth.user.id, q.page);
  }

  @Get('checkout-defaults')
  checkoutDefaults(@CurrentAuth() auth: AuthContext) {
    return this.orders.checkoutDefaults(auth.user.id);
  }

  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.orders.get(auth.user.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CancelOrderDto) {
    return this.orders.cancelByCustomer(auth.user.id, id, dto.reason);
  }

  @Get(':id/payment/bank-transfer')
  bankTransfer(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.orders.bankTransferDetails(auth.user.id, id);
  }

  /** «Я оплатил» */
  @Post(':id/payment/bank-transfer/paid')
  @HttpCode(200)
  reportPaid(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ReportPaymentDto) {
    return this.orders.reportBankTransferPaid(auth.user.id, id, dto.receipt_url);
  }
}
