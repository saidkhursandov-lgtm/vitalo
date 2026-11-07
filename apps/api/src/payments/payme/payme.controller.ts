import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { PaymeService } from './payme.service';

/**
 * The address Payme calls (Merchant API, JSON-RPC 2.0): https://api.vitalo.uz/api/payments/payme — it is entered in the
 * cash desk settings in Payme Business. Public: the Basic key in Authorization is checked by PaymeService.
 */
@ApiTags('payments')
@Controller('payments/payme')
export class PaymeController {
  constructor(private readonly payme: PaymeService) {}

  @Post()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  rpc(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    return this.payme.handle(authorization, body);
  }
}
