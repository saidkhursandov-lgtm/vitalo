import { Body, Controller, Get, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { AuthService } from './auth.service';
import { AuthContext, toUserProfile } from './auth.types';
import { CurrentAuth, SessionGuard } from './session.guard';

export class TelegramLoginDto {
  @ApiProperty({ description: 'Telegram.WebApp.initData (raw string, as is)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  initData!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('telegram')
  @HttpCode(200)
  login(@Body() dto: TelegramLoginDto, @Headers('user-agent') userAgent?: string) {
    return this.auth.loginWithTelegram(dto.initData, userAgent);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(SessionGuard)
  me(@CurrentAuth() auth: AuthContext) {
    return toUserProfile(auth.user);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  @UseGuards(SessionGuard)
  async logout(@CurrentAuth() auth: AuthContext) {
    await this.auth.logout(auth.sessionId);
  }
}
