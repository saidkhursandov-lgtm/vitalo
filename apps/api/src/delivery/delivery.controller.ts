import { Controller, Get, Query } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsUUID, Min } from 'class-validator';
import { DeliveryService } from './delivery.service';

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

  @Get('quote')
  quote(@Query() q: DeliveryQuoteQuery) {
    return this.delivery.quote(q.region_id, q.city_id, q.goods_total_uzs);
  }
}
