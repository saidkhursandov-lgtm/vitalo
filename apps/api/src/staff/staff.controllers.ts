import { Body, Controller, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TelegramLoginDto } from '../auth/auth.controller';
import { permissionsOf } from './permissions';
import { CurrentStaff, StaffAuthService, StaffContext, StaffGuard } from './staff-auth';
import { clearAuthCookies } from './staff-web-auth';

@ApiTags('staff: auth')
@Controller('staff/auth')
export class StaffAuthController {
  constructor(private readonly auth: StaffAuthService) {}

  @Post('telegram')
  @HttpCode(200)
  async login(@Body() dto: TelegramLoginDto) {
    const res = await this.auth.login(dto.initData);
    return { ...res, permissions: permissionsOf(res.staff.role, res.staff.is_specialist) };
  }

  /** Current employee + what they may do (the admin UI builds its menu from this). */
  @Get('me')
  @ApiBearerAuth()
  @UseGuards(StaffGuard)
  me(@CurrentStaff() me: StaffContext) {
    const s = me.staff;
    return { staff: { id: s.id, name: s.name, role: s.role, is_specialist: s.is_specialist }, permissions: permissionsOf(s.role, s.is_specialist) };
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  @UseGuards(StaffGuard)
  async logout(@CurrentStaff() me: StaffContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(me.sessionId);
    clearAuthCookies(res); // the browser stays «confirmed»: next login needs only Telegram
  }
}
