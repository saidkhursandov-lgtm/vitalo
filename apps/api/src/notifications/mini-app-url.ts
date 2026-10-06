import type { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/** Written by the tunnel script for the bot (start.bat); the same files tell the API where the Mini App / admin are. */
const RUNTIME_FILE = resolve(__dirname, '..', '..', '..', '..', '.runtime', 'miniapp-url.txt');
const ADMIN_RUNTIME_FILE = resolve(__dirname, '..', '..', '..', '..', '.runtime', 'admin-url.txt');

/**
 * HTTPS address of the Mini App for buttons under bot messages: MINIAPP_URL, else the current tunnel address.
 * null when unknown (the message is then sent without a button).
 */
export function miniAppUrl(config: Pick<ConfigService, 'get'>, file = RUNTIME_FILE): string | null {
  return httpsUrl(config.get<string>('MINIAPP_URL'), file);
}

/** HTTPS address of the admin panel (ADMIN_URL, else the current tunnel address) for buttons under staff messages. */
export function adminUrl(config: Pick<ConfigService, 'get'>, file = ADMIN_RUNTIME_FILE): string | null {
  return httpsUrl(config.get<string>('ADMIN_URL'), file);
}

function httpsUrl(fromEnv: string | undefined, file: string): string | null {
  let url = fromEnv?.trim();
  if (!url) {
    try {
      url = readFileSync(file, 'utf8').trim();
    } catch {
      return null;
    }
  }
  return /^https:\/\/[^\s]+$/.test(url) ? url.replace(/\/$/, '') : null;
}
