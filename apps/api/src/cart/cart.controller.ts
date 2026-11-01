import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';
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

export class ApplyPromoDto extends CartQuery {
  @ApiProperty({ example: 'VITALO10', description: 'Регистр и пробелы по краям не важны' })
  @IsString()
  @MaxLength(64)
  code!: string;
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

  /** 3.1: 2–3 products to reach free delivery (empty when not needed). */
  @Get('upsell')
  upsell(@CurrentAuth() auth: AuthContext, @Query() q: CartQuery) {
    const address = q.region_id && q.city_id ? { region_id: q.region_id, city_id: q.city_id } : undefined;
    return this.cart.upsell(auth.user.id, address);
  }

  /** Badge counter; does not consume the "price changed / qty reduced" warnings. */
  @Get('count')
  count(@CurrentAuth() auth: AuthContext) {
    return this.cart.count(auth.user.id);
  }

  @Post('items')
  add(@CurrentAuth() auth: AuthContext, @Body() dto: AddCartItemDto) {
    return this.cart.addItem(auth.user.id, dto.product_id, dto.qty);
  }

  @Patch('items/:productId')
  setQty(@CurrentAuth() auth: AuthContext, @Param('productId', new ParseUUIDPipe()) productId: string, @Body() dto: SetQtyDto) {
    return this.cart.setQty(auth.user.id, productId, dto.qty);
  }

  /** 3.3: «Применить» — 422 PROMO_REJECTED with the reason and RU/UZ text when the code does not fit. */
  @Post('promo')
  applyPromo(@CurrentAuth() auth: AuthContext, @Body() dto: ApplyPromoDto) {
    const address = dto.region_id && dto.city_id ? { region_id: dto.region_id, city_id: dto.city_id } : undefined;
    return this.cart.applyPromo(auth.user.id, dto.code, address);
  }

  /** 3.3: [✕] on the applied code. */
  @Delete('promo')
  removePromo(@CurrentAuth() auth: AuthContext, @Query() q: CartQuery) {
    const address = q.region_id && q.city_id ? { region_id: q.region_id, city_id: q.city_id } : undefined;
    return this.cart.removePromo(auth.user.id, address);
  }

  @Delete('items/:productId')
  remove(@CurrentAuth() auth: AuthContext, @Param('productId', new ParseUUIDPipe()) productId: string) {
    return this.cart.removeItem(auth.user.id, productId);
  }
}
