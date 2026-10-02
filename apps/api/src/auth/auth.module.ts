import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { InitDataVerifier } from './init-data.verifier';
import { SessionGuard } from './session.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionGuard, InitDataVerifier],
  exports: [AuthService, SessionGuard, InitDataVerifier],
})
export class AuthModule {}
