import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TelegramLoginDto } from '../auth/auth.controller';
import { permissionsOf } from './permissions';
import { CurrentStaff, StaffAuthService, StaffContext, StaffGuard } from './staff-auth';

@ApiTags('staff: auth')
@Controller('staff/auth')
export class StaffAuthController {
  constructor(private readonly auth: StaffAuthService) {}

  @Post('telegram')
  @HttpCode(200)
  async login(@Body() dto: TelegramLoginDto) {
    const res = await this.auth.login(dto.initData);
    return { ...res, permissions: permissionsOf(res.staff.role) };
  }

  /** Current employee + what they may do (the admin UI builds its menu from this). */
  @Get('me')
  @ApiBearerAuth()
  @UseGuards(StaffGuard)
  me(@CurrentStaff() me: StaffContext) {
    const s = me.staff;
    return { staff: { id: s.id, name: s.name, role: s.role }, permissions: permissionsOf(s.role) };
  }

  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  @UseGuards(StaffGuard)
  async logout(@CurrentStaff() me: StaffContext) {
    await this.auth.logout(me.sessionId);
  }
}
