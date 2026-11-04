import { Body, Controller, Headers, HttpCode, Module, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
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

class StartOnlinePaymentDto {
  @IsOptional() @IsIn(['ru', 'uz']) lang?: 'ru' | 'uz';
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
    return this.online.start(auth.user.id, orderId, provider, dto.lang ?? 'ru');
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

/** Registered system modules (Payme, Click, Uzum) go here, each one separately: Payme (Merchant API) is connected. */
@Module({
  imports: [AuthModule, OrdersModule],
  controllers: [OnlinePaymentsController, PaymeController],
  providers: [
    OnlinePaymentsService,
    PaymeService,
    PaymeGateway,
    { provide: ONLINE_GATEWAYS, useFactory: (payme: PaymeGateway): OnlinePaymentGateway[] => [payme], inject: [PaymeGateway] },
  ],
  exports: [OnlinePaymentsService],
})
export class OnlinePaymentsModule {}
