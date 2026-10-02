import { createHmac, timingSafeEqual } from 'crypto';

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface ValidatedInitData {
  user: TelegramUser;
  auth_date: number;
  start_param?: string; // referral code arrives here: t.me/bot/app?startapp=<code>
}

export class InitDataError extends Error {}

/**
 * Server-side validation of Telegram Mini App initData.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Must be called for EVERY auth request; never trust initDataUnsafe from the client.
 */
export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 3600,
  now: number = Math.floor(Date.now() / 1000),
): ValidatedInitData {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new InitDataError('hash missing');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();

  let given: Buffer;
  try {
    given = Buffer.from(hash, 'hex');
  } catch {
    throw new InitDataError('bad hash');
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new InitDataError('signature mismatch');
  }

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || now - authDate > maxAgeSeconds || authDate - now > 60) {
    throw new InitDataError('initData expired');
  }

  const userRaw = params.get('user');
  if (!userRaw) throw new InitDataError('user missing');
  let user: TelegramUser;
  try {
    user = JSON.parse(userRaw) as TelegramUser;
  } catch {
    throw new InitDataError('bad user');
  }
  if (!user?.id || !user.first_name) throw new InitDataError('bad user');

  return { user, auth_date: authDate, start_param: params.get('start_param') ?? undefined };
}
