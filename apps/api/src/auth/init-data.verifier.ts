import { Injectable, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InitDataError, validateInitData, ValidatedInitData } from './telegram-init-data';

/** Validates Telegram initData with the bot token from config; shared by customer and staff login. */
@Injectable()
export class InitDataVerifier {
  constructor(private readonly config: ConfigService) {}

  verify(initData: string): ValidatedInitData {
    const botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken) throw new InternalServerErrorException('TELEGRAM_BOT_TOKEN is not configured');
    const maxAge = Number(this.config.get('INIT_DATA_MAX_AGE_SECONDS') ?? 3600);
    try {
      return validateInitData(initData, botToken, maxAge);
    } catch (e) {
      if (e instanceof InitDataError) throw new UnauthorizedException(`Invalid initData: ${e.message}`);
      throw e;
    }
  }
}
