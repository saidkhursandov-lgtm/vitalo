import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { MAX_LINE_QTY } from '../cart/cart-reconcile';
import { PageQuery } from '../catalog/catalog.dto';

export const PAYMENT_METHOD_CODES = ['card_transfer', 'bank_transfer', 'cod', 'payme', 'click', 'uzum'] as const;
export type PaymentMethodCode = (typeof PAYMENT_METHOD_CODES)[number];

/** "90 123-45-67", "+998 90 1234567", "998901234567" -> "+998901234567". */
export function normalizeUzPhone(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 9) return `+998${digits}`;
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  return value;
}

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class BuyNowDto {
  @ApiProperty() @IsUUID() product_id!: string;
  @ApiProperty({ minimum: 1, maximum: MAX_LINE_QTY }) @IsInt() @Min(1) @Max(MAX_LINE_QTY) qty!: number;
}

/** Checkout data. Prices, stock, discounts and totals are never taken from the client. */
export class CheckoutDto {
  @ApiProperty({ enum: ['cart', 'buy_now'], description: 'cart — товары из корзины; buy_now — один товар, корзина не меняется' })
  @IsIn(['cart', 'buy_now'])
  source!: 'cart' | 'buy_now';

  @ApiPropertyOptional({ type: BuyNowDto })
  @ValidateIf((o: CheckoutDto) => o.source === 'buy_now')
  @IsDefined()
  @ValidateNested()
  @Type(() => BuyNowDto)
  buy_now?: BuyNowDto;

  @ApiProperty({ example: 'Алишер Каримов' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  recipient_name!: string;

  @ApiProperty({ example: '+998901234567' })
  @Transform(({ value }) => normalizeUzPhone(value))
  @Matches(/^\+998\d{9}$/, { message: 'recipient_phone must be an Uzbek number: +998XXXXXXXXX' })
  recipient_phone!: string;

  @ApiProperty() @IsUUID() region_id!: string;
  @ApiProperty() @IsUUID() city_id!: string;

  @ApiProperty({ example: 'ул. Амира Темура, 1, кв. 5' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  address_text!: string;

  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-90) @Max(90) latitude?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-180) @Max(180) longitude?: number;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500) customer_comment?: string;

  @ApiProperty({ enum: PAYMENT_METHOD_CODES, example: 'bank_transfer' })
  @IsIn(PAYMENT_METHOD_CODES)
  payment_method!: PaymentMethodCode;

  @ApiPropertyOptional({
    description: '3.3: промокод. Не передан — для корзины берётся сохранённый в корзине; пустая строка — без промокода',
    example: 'VITALO10',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  promo_code?: string;

  @ApiPropertyOptional({ description: '3.10-А: списать бонусы. Не передан — для корзины берётся переключатель корзины' })
  @IsOptional()
  @IsBoolean()
  use_bonus?: boolean;
}

/** The confirmation screen recalculates as soon as the city is chosen, before name/phone are typed. */
export class OrderPreviewDto extends PickType(CheckoutDto, ['source', 'buy_now', 'region_id', 'city_id', 'payment_method', 'promo_code', 'use_bonus'] as const) {}

export class CreateOrderDto extends CheckoutDto {
  @ApiPropertyOptional({
    description: 'Итог, который клиент видел на экране подтверждения. Если сервер насчитал другое — 409 PRICE_CHANGED.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expected_total_uzs?: number;
}

export class CancelOrderDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(500) reason?: string;
}

export class ReportPaymentDto {
  @ApiPropertyOptional({ description: 'Ссылка на чек (необязательно)' })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(1000)
  receipt_url?: string;
}

export class ListOrdersQuery extends PageQuery {}
