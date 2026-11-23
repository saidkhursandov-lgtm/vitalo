import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { ClickService } from './click.service';

/**
 * The addresses Click calls (SHOP API, form-urlencoded → JSON), entered in the service settings at merchant.click.uz:
 *   Prepare:  https://api.vitalo.uz/api/payments/click/prepare
 *   Complete: https://api.vitalo.uz/api/payments/click/complete
 * Public: ClickService checks the signature (sign_string) of every request.
 */
@ApiTags('payments')
@Controller('payments/click')
export class ClickController {
  constructor(private readonly click: ClickService) {}

  @Post('prepare')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  prepare(@Body() body: unknown) {
    return this.click.prepare(body);
  }

  @Post('complete')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  complete(@Body() body: unknown) {
    return this.click.complete(body);
  }
}
