import { Body, Controller, Get, Headers, HttpCode, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { AuthService } from './auth.service';
import { AuthContext, toUserProfile } from './auth.types';
import { CurrentAuth, SessionGuard } from './session.guard';

export class TelegramLoginDto {
  @ApiProperty({ description: 'Telegram.WebApp.initData (raw string, as is)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  initData!: string;

  @ApiPropertyOptional({ description: "Реферальный код из ссылки бота, если Telegram не передал его в initData", example: "REF123" })
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  start_param?: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ enum: ['ru', 'uz'] }) @IsOptional() @IsIn(['ru', 'uz']) language?: 'ru' | 'uz';
  @ApiPropertyOptional() @IsOptional() @IsBoolean() marketing_opt_in?: boolean;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('telegram')
  @HttpCode(200)
  login(@Body() dto: TelegramLoginDto, @Headers('user-agent') userAgent?: string) {
    return this.auth.loginWithTelegram(dto.initData, userAgent, dto.start_param);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(SessionGuard)
  me(@CurrentAuth() auth: AuthContext) {
    return toUserProfile(auth.user);
  }

  @Patch('me')
  @ApiBearerAuth()
  @UseGuards(SessionGuard)
  async updateMe(@CurrentAuth() auth: AuthContext, @Body() dto: UpdateProfileDto) {
    return toUserProfile(await this.auth.updateProfile(auth.user.id, dto));
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  @UseGuards(SessionGuard)
  async logout(@CurrentAuth() auth: AuthContext) {
    await this.auth.logout(auth.sessionId);
  }
}
