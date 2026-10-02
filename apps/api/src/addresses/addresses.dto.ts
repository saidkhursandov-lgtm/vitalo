import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class AddressDto {
  @ApiPropertyOptional({ example: 'Дом' }) @IsOptional() @Transform(trim) @IsString() @MaxLength(50) label?: string;
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

  @ApiPropertyOptional({ description: 'Сделать основным (первый адрес всегда основной)' })
  @IsOptional()
  @IsBoolean()
  is_primary?: boolean;
}

/** Primary is changed only via POST /addresses/:id/primary, so it is not editable here. */
export class UpdateAddressDto extends PartialType(OmitType(AddressDto, ['is_primary'] as const)) {}
