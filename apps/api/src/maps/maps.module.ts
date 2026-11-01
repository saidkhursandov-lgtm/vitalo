import { Controller, Get, Module, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { AuthModule } from '../auth/auth.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { MapsService } from './maps.service';

export class GeocodeQuery {
  @ApiProperty({ example: 41.2995 }) @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat!: number;
  @ApiProperty({ example: 69.2401 }) @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lon!: number;
  @ApiPropertyOptional({ enum: ['ru', 'uz'] }) @IsOptional() @IsIn(['ru', 'uz']) lang?: 'ru' | 'uz';
}

/** 3.6: the map in the Mini App. Only for a signed-in customer: the geocoder has a small daily limit. */
@ApiTags('maps')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('maps')
export class MapsController {
  constructor(private readonly maps: MapsService) {}

  /** Show «Выбрать на карте»? available=false → «Карта временно недоступна, введите адрес вручную». */
  @Get('config')
  config() {
    return this.maps.clientConfig();
  }

  /** The address under the map pin (the customer stopped moving the map). */
  @Get('geocode')
  geocode(@CurrentAuth() auth: AuthContext, @Query() q: GeocodeQuery) {
    return this.maps.geocode(auth.user.id, q.lat, q.lon, q.lang ?? (auth.user.language === 'uz' ? 'uz' : 'ru'));
  }
}

@Module({
  imports: [AuthModule],
  controllers: [MapsController],
  providers: [MapsService],
  exports: [MapsService],
})
export class MapsModule {}
