import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export enum ProductSort {
  popular = 'popular',
  price_asc = 'price_asc',
  price_desc = 'price_desc',
  new = 'new',
}

/** Accepts both `?brand=A,B` and `?brand=A&brand=B`. */
const toStringArray = ({ value }: { value: unknown }) => {
  if (value == null || value === '') return undefined;
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map((v) => String(v).trim()).filter(Boolean);
};

export class PageQuery {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;
}

export class ListProductsQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'slug категории (подкатегории включаются)', example: 'vitamins' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ type: [String], description: 'Бренд(ы) через запятую', example: 'SunVita' })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsString({ each: true })
  brand?: string[];

  @ApiPropertyOptional({ description: 'Мин. цена, сум' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  price_min?: number;

  @ApiPropertyOptional({ description: 'Макс. цена, сум' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  price_max?: number;

  @ApiPropertyOptional({ enum: ProductSort, default: ProductSort.popular })
  @IsOptional()
  @IsEnum(ProductSort)
  sort: ProductSort = ProductSort.popular;
}

export class SearchQuery extends PageQuery {
  @ApiProperty({ description: 'Строка поиска (кириллица/латиница, опечатки допустимы)', example: 'kolagen' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  q!: string;
}
