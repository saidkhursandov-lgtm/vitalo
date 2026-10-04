import type { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/** Written by the tunnel script for the bot (start.bat); the same file tells the API where the Mini App is. */
const RUNTIME_FILE = resolve(__dirname, '..', '..', '..', '..', '.runtime', 'miniapp-url.txt');

/**
 * HTTPS address of the Mini App for buttons under bot messages: MINIAPP_URL, else the current tunnel address.
 * null when unknown (the message is then sent without a button).
 */
export function miniAppUrl(config: Pick<ConfigService, 'get'>, file = RUNTIME_FILE): string | null {
  let url = config.get<string>('MINIAPP_URL')?.trim();
  if (!url) {
    try {
      url = readFileSync(file, 'utf8').trim();
    } catch {
      return null;
    }
  }
  return /^https:\/\/[^\s]+$/.test(url) ? url.replace(/\/$/, '') : null;
}
