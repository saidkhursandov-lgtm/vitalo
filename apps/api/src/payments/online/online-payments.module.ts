import { Body, Controller, Get, Headers, HttpCode, Module, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthModule } from '../../auth/auth.module';
import { AuthContext } from '../../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../../auth/session.guard';
import { OrdersModule } from '../../orders/orders.module';
import { ONLINE_GATEWAYS, type OnlinePaymentGateway } from './online-providers';
import { OnlinePaymentsService } from './online-payments.service';
import { PaymeController } from '../payme/payme.controller';
import { PaymeGateway } from '../payme/payme.gateway';
import { PaymeService } from '../payme/payme.service';
import { ClickController } from '../click/click.controller';
import { ClickGateway } from '../click/click.gateway';
import { ClickService } from '../click/click.service';

class StartOnlinePaymentDto {
  @IsOptional() @IsIn(['ru', 'uz']) lang?: 'ru' | 'uz';
  /** Release 6: paid on vitalo.uz — after paying, back to the order page of the site (else to the shop bot) */
  @IsOptional() @IsIn(['site']) return_to?: 'site';
}

class ChangePaymentMethodDto {
  @IsString() @Matches(/^[a-z_]{2,32}$/) method!: string;
}

@ApiTags('payments')
@Controller('payments/online')
export class OnlinePaymentsController {
  constructor(private readonly online: OnlinePaymentsService) {}

  @Post(':provider/orders/:orderId/start')
  @ApiBearerAuth()
  @UseGuards(SessionGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'Создать онлайн-платёж и получить ссылку на страницу оплаты (в 2.1 — «не подключено»)' })
  start(@CurrentAuth() auth: AuthContext, @Param('provider') provider: string, @Param('orderId') orderId: string, @Body() dto: StartOnlinePaymentDto) {
    return this.online.start(auth.user.id, orderId, provider, dto.lang ?? 'ru', dto.return_to);
  }

  @Get('orders/:orderId/methods')
  @ApiBearerAuth()
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Чем можно оплатить неоплаченный заказ сейчас (экран «Оплата заказа»)' })
  methods(@CurrentAuth() auth: AuthContext, @Param('orderId') orderId: string) {
    return this.online.methods(auth.user.id, orderId);
  }

  @Post('orders/:orderId/method')
  @ApiBearerAuth()
  @UseGuards(SessionGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'Сменить способ оплаты неоплаченного заказа (сумма и резерв не меняются)' })
  changeMethod(@CurrentAuth() auth: AuthContext, @Param('orderId') orderId: string, @Body() dto: ChangePaymentMethodDto) {
    return this.online.changeMethod(auth.user.id, orderId, dto.method);
  }

  /** Address for confirmations from Payme / Click / Uzum. Public: each system module checks the signature itself. */
  @Post(':provider/callback')
  @ApiOperation({ summary: 'Подтверждение от платёжной системы (в 2.1 отвечает 501 «не подключено»)' })
  async callback(
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
  ) {
    const reply = await this.online.callback(provider, { headers, body: req.body, rawBody: req.rawBody });
    res.status(reply.status).json(reply.body);
  }
}

/** Registered system modules (Payme, Click, Uzum) go here, each one separately: Payme (Merchant API) and Click (SHOP API) are connected. */
@Module({
  imports: [AuthModule, OrdersModule],
  controllers: [OnlinePaymentsController, PaymeController, ClickController],
  providers: [
    OnlinePaymentsService,
    PaymeService,
    PaymeGateway,
    ClickService,
    ClickGateway,
    {
      provide: ONLINE_GATEWAYS,
      useFactory: (payme: PaymeGateway, click: ClickGateway): OnlinePaymentGateway[] => [payme, click],
      inject: [PaymeGateway, ClickGateway],
    },
  ],
  exports: [OnlinePaymentsService],
})
export class OnlinePaymentsModule {}
