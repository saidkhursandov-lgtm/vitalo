import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsUUID, Min } from 'class-validator';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { DeliveryService } from './delivery.service';

export class DeliveryCityQuery {
  @ApiProperty() @IsUUID() region_id!: string;
  @ApiProperty() @IsUUID() city_id!: string;
}

export class DeliveryQuoteQuery {
  @ApiProperty() @IsUUID() region_id!: string;
  @ApiProperty() @IsUUID() city_id!: string;
  @ApiProperty({ description: 'Сумма товаров после скидок, сум', example: 250000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  goods_total_uzs!: number;
}

@ApiTags('delivery')
@Controller('delivery')
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  @Get('regions')
  regions() {
    return this.delivery.listRegions();
  }

  @Get('terms')
  terms() {
    return this.delivery.terms();
  }

  /** Home page: the free-delivery threshold and whether this customer's first order is free. */
  @Get('free-shipping')
  @UseGuards(SessionGuard)
  @ApiBearerAuth()
  freeShipping(@CurrentAuth() auth: AuthContext) {
    return this.delivery.freeShippingInfo(auth.user.id);
  }

  @Get('eta')
  eta(@Query() q: DeliveryCityQuery) {
    return this.delivery.eta(q.region_id, q.city_id);
  }

  @Get('quote')
  quote(@Query() q: DeliveryQuoteQuery) {
    return this.delivery.quote(q.region_id, q.city_id, q.goods_total_uzs);
  }
}
