import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Max, Min, ValidateIf } from 'class-validator';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { MAX_LINE_QTY } from './cart-reconcile';
import { CartService } from './cart.service';

export class AddCartItemDto {
  @ApiProperty() @IsUUID() product_id!: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) @Max(MAX_LINE_QTY) qty: number = 1;
}

export class SetQtyDto {
  @ApiProperty({ minimum: 1, maximum: MAX_LINE_QTY }) @IsInt() @Min(1) @Max(MAX_LINE_QTY) qty!: number;
}

export class CartQuery {
  @ApiPropertyOptional({ description: 'Для расчёта доставки (вместе с city_id)' })
  @ValidateIf((q: CartQuery) => q.city_id !== undefined || q.region_id !== undefined)
  @IsUUID()
  region_id?: string;

  @ApiPropertyOptional()
  @ValidateIf((q: CartQuery) => q.city_id !== undefined || q.region_id !== undefined)
  @IsUUID()
  city_id?: string;
}

@ApiTags('cart')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  get(@CurrentAuth() auth: AuthContext, @Query() q: CartQuery) {
    const address = q.region_id && q.city_id ? { region_id: q.region_id, city_id: q.city_id } : undefined;
    return this.cart.getCart(auth.user.id, address);
  }

  @Post('items')
  add(@CurrentAuth() auth: AuthContext, @Body() dto: AddCartItemDto) {
    return this.cart.addItem(auth.user.id, dto.product_id, dto.qty);
  }

  @Patch('items/:productId')
  setQty(@CurrentAuth() auth: AuthContext, @Param('productId', new ParseUUIDPipe()) productId: string, @Body() dto: SetQtyDto) {
    return this.cart.setQty(auth.user.id, productId, dto.qty);
  }

  @Delete('items/:productId')
  remove(@CurrentAuth() auth: AuthContext, @Param('productId', new ParseUUIDPipe()) productId: string) {
    return this.cart.removeItem(auth.user.id, productId);
  }
}
