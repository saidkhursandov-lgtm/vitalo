import { Module } from '@nestjs/common';
import { BotSecretGuard } from '../bot-internal/bot-internal.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { InitDataVerifier } from './init-data.verifier';
import { SessionGuard } from './session.guard';
import { BotCustomerLoginController, CustomerWebLoginController, CustomerWebLoginService } from './web-login';

@Module({
  controllers: [AuthController, CustomerWebLoginController, BotCustomerLoginController],
  providers: [AuthService, SessionGuard, InitDataVerifier, CustomerWebLoginService, BotSecretGuard],
  exports: [AuthService, SessionGuard, InitDataVerifier],
})
export class AuthModule {}
