import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { BotSecretGuard } from '../bot-internal/bot-internal.module';
import { TELEGRAM_SENDER, type TelegramSender } from '../notifications/telegram-sender';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { generateSessionToken } from './session-token';

/**
 * Release 6 «Сайт» (D-30): the customer signs in on vitalo.uz outside Telegram. The record is the same `users` row as in
 * the Mini App (telegram_user_id + phone) — no second table of customers.
 * - «Войти через Telegram»: the site opens t.me/<bot>?start=login_<id>; the bot confirms with the sender's Telegram
 *   account (it may create the customer); the browser polls and gets a session.
 * - «По номеру телефона»: the customer with this users.phone gets a 6-digit code from the bot; the browser sends it back.
 *   Unknown numbers get the same answer (no way to learn who is a customer); no code is sent to them.
 */

export const LOGIN_TTL_MS = 5 * 60_000;
export const CODE_ATTEMPTS = 5;
const PHONE_REQUESTS_PER_10_MIN = 3;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** +998XXXXXXXXX from what people type (9 digits, 998…, spaces, dashes, brackets); null if it is not an Uzbek number. */
export function normalizeLoginPhone(raw: string): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length === 9) return `+998${digits}`;
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  return null;
}

/** The start payload of the bot link: login_ + the request id without dashes (fits Telegram's 64 chars, [A-Za-z0-9_]). */
export const loginPayload = (id: string) => `login_${id.replace(/-/g, '')}`;
export function requestIdFromPayload(hex: string): string | null {
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A small in-memory limit per IP (one API process), like the staff login. */
class Attempts {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  take(key: string) {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) throw tooMany();
    list.push(now);
    this.hits.set(key, list);
  }
}
const tooMany = () =>
  new HttpException({ code: 'TOO_MANY_ATTEMPTS', message: 'Слишком много попыток. Попробуйте через 15 минут.' }, HttpStatus.TOO_MANY_REQUESTS);

const CODE_TEXT = {
  ru: (code: string) => `Код для входа на vitalo.uz: ${code}\n\nНикому не сообщайте его. Если вы не входили на сайт — просто не отвечайте на это сообщение.`,
  uz: (code: string) => `vitalo.uz saytiga kirish kodi: ${code}\n\nUni hech kimga aytmang. Agar saytga kirmagan bo‘lsangiz — bu xabarga javob bermang.`,
};

export interface TelegramFrom {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

@Injectable()
export class CustomerWebLoginService {
  private readonly log = new Logger(CustomerWebLoginService.name);
  private readonly perIp = new Attempts(20, 15 * 60_000);
  private botUsername: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    @Inject(TELEGRAM_SENDER) private readonly sender: TelegramSender,
  ) {}

  /** TELEGRAM_BOT_USERNAME, or asked once from Telegram (getMe) with the same token. */
  async bot(): Promise<string | null> {
    const fromEnv = this.config.get<string>('TELEGRAM_BOT_USERNAME')?.replace(/^@/, '').trim();
    if (fromEnv) return fromEnv;
    if (this.botUsername) return this.botUsername;
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return null;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8_000) });
      const body = (await res.json()) as { ok?: boolean; result?: { username?: string } };
      this.botUsername = body.ok ? (body.result?.username ?? null) : null;
    } catch {
      this.log.warn('getMe failed (network)'); // never log the URL: it holds the token
    }
    return this.botUsername;
  }

  /** «Войти через Telegram», step 1: a request and the bot link. */
  async startTelegram(ua: string | undefined, ip: string | null) {
    this.perIp.take(ip ?? '-');
    const bot = await this.bot();
    if (!bot) throw new BadRequestException({ code: 'BOT_NOT_CONFIGURED', message: 'Бот не настроен' });
    const id = randomUUID();
    const poll = generateSessionToken();
    const expires = new Date(Date.now() + LOGIN_TTL_MS);
    await this.prisma.customer_login_requests.create({
      data: { id, kind: 'telegram', poll_hash: sha(poll), device_info: ua?.slice(0, 255) ?? null, ip, expires_at: expires },
    });
    return { request_id: id, poll_token: poll, bot_url: `https://t.me/${bot}?start=${loginPayload(id)}`, expires_at: expires.toISOString() };
  }

  /** Step 2 (the bot): the Telegram account that pressed «Start» signs this browser in. */
  async confirmTelegram(hex: string, from: TelegramFrom): Promise<{ result: 'approved' | 'expired' | 'already' | 'blocked'; lang: 'ru' | 'uz' }> {
    const fallbackLang = from.language_code?.toLowerCase().startsWith('uz') ? 'uz' : 'ru';
    const id = requestIdFromPayload(hex);
    const req = id ? await this.prisma.customer_login_requests.findUnique({ where: { id } }) : null;
    if (!req || req.kind !== 'telegram') return { result: 'expired', lang: fallbackLang };
    if (req.approved_at || req.used_at) return { result: 'already', lang: fallbackLang };
    if (req.expires_at <= new Date()) return { result: 'expired', lang: fallbackLang };
    if (!Number.isSafeInteger(from.id) || from.id <= 0 || !from.first_name) return { result: 'expired', lang: fallbackLang };

    const { user } = await this.auth.upsertTelegramUser(from);
    if (user.status !== 'active' || user.deleted_at) return { result: 'blocked', lang: user.language };
    const res = await this.prisma.customer_login_requests.updateMany({
      where: { id: req.id, approved_at: null, used_at: null },
      data: { approved_at: new Date(), user_id: user.id },
    });
    return { result: res.count ? 'approved' : 'already', lang: user.language };
  }

  /** Step 3 (the browser, every 2 s): pending until the bot confirmed; then the session, once. */
  async poll(requestId: string, pollToken: string) {
    const req = await this.findOwn(requestId, pollToken);
    if (!req || req.kind !== 'telegram' || req.used_at) return { status: 'expired' as const };
    if (!req.approved_at || !req.user_id) return req.expires_at <= new Date() ? { status: 'expired' as const } : { status: 'pending' as const };
    const taken = await this.prisma.customer_login_requests.updateMany({ where: { id: req.id, used_at: null }, data: { used_at: new Date() } });
    if (!taken.count) return { status: 'expired' as const };
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: req.user_id } });
    if (user.status !== 'active' || user.deleted_at) return { status: 'expired' as const };
    return { status: 'approved' as const, ...(await this.auth.createSession(user, req.device_info ?? undefined)) };
  }

  /** «По номеру телефона», step 1: a code from the bot to the customer with this number (if there is one). */
  async startPhone(rawPhone: string, ua: string | undefined, ip: string | null) {
    this.perIp.take(ip ?? '-');
    const phone = normalizeLoginPhone(rawPhone);
    if (!phone) throw new BadRequestException({ code: 'BAD_PHONE', message: 'Введите номер в формате +998 XX XXX XX XX' });
    const recent = await this.prisma.customer_login_requests.count({
      where: { kind: 'phone', phone, created_at: { gt: new Date(Date.now() - 10 * 60_000) } },
    });
    if (recent >= PHONE_REQUESTS_PER_10_MIN) throw tooMany();

    const user = await this.prisma.users.findFirst({
      where: { phone, status: 'active', deleted_at: null },
      orderBy: { updated_at: 'desc' },
    });
    const id = randomUUID();
    const poll = generateSessionToken();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expires = new Date(Date.now() + LOGIN_TTL_MS);
    await this.prisma.customer_login_requests.create({
      data: {
        id,
        kind: 'phone',
        poll_hash: sha(poll),
        code_hash: sha(`${id}:${code}`),
        phone,
        user_id: user?.id ?? null,
        device_info: ua?.slice(0, 255) ?? null,
        ip,
        expires_at: expires,
      },
    });
    if (user) {
      try {
        await this.sender.sendMessage(user.telegram_user_id, CODE_TEXT[user.language](code));
      } catch {
        this.log.warn('login code not delivered'); // blocked bot etc.; the answer stays the same
      }
    }
    return { request_id: id, poll_token: poll, expires_at: expires.toISOString(), bot: await this.bot() };
  }

  /** Step 2: the code. Five tries per request; the same error whether the number is unknown or the code is wrong. */
  async verifyPhone(requestId: string, pollToken: string, code: string) {
    const req = await this.findOwn(requestId, pollToken);
    if (!req || req.kind !== 'phone' || req.used_at || req.expires_at <= new Date()) {
      throw new BadRequestException({ code: 'CODE_EXPIRED', message: 'Код устарел. Запросите новый.' });
    }
    if (req.attempts >= CODE_ATTEMPTS) throw new BadRequestException({ code: 'CODE_EXPIRED', message: 'Код устарел. Запросите новый.' });
    await this.prisma.customer_login_requests.update({ where: { id: req.id }, data: { attempts: { increment: 1 } } });
    const ok = !!req.code_hash && /^\d{6}$/.test(code) && sameHash(sha(`${req.id}:${code}`), req.code_hash);
    if (!ok || !req.user_id) {
      throw new BadRequestException({ code: 'BAD_CODE', message: 'Неверный код', attempts_left: Math.max(0, CODE_ATTEMPTS - req.attempts - 1) });
    }
    const taken = await this.prisma.customer_login_requests.updateMany({ where: { id: req.id, used_at: null }, data: { used_at: new Date(), approved_at: new Date() } });
    if (!taken.count) throw new BadRequestException({ code: 'CODE_EXPIRED', message: 'Код устарел. Запросите новый.' });
    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: req.user_id } });
    if (user.status !== 'active' || user.deleted_at) throw new BadRequestException({ code: 'CODE_EXPIRED', message: 'Код устарел. Запросите новый.' });
    return this.auth.createSession(user, req.device_info ?? undefined);
  }

  private async findOwn(requestId: string, pollToken: string) {
    if (!/^[0-9a-f-]{36}$/.test(requestId) || !pollToken) return null;
    const req = await this.prisma.customer_login_requests.findUnique({ where: { id: requestId } });
    return req && sameHash(sha(pollToken), req.poll_hash) ? req : null;
  }
}

const clientIp = (req: Request) => (req.header('x-real-ip') || req.ip || '').slice(0, 64) || null;

class PollDto {
  @ApiProperty() @IsString() @Matches(/^[0-9a-f-]{36}$/) request_id!: string;
  @ApiProperty() @IsString() @MaxLength(200) poll_token!: string;
}
class PhoneStartDto {
  @ApiProperty({ example: '+998 90 123 45 67' }) @IsString() @MaxLength(32) phone!: string;
}
class PhoneVerifyDto extends PollDto {
  @ApiProperty({ example: '123456' }) @IsString() @Matches(/^\d{6}$/) code!: string;
}

@ApiTags('auth')
@Controller('auth/web')
export class CustomerWebLoginController {
  constructor(private readonly web: CustomerWebLoginService) {}

  @Post('telegram/start')
  @HttpCode(200)
  startTelegram(@Req() req: Request, @Headers('user-agent') ua?: string) {
    return this.web.startTelegram(ua, clientIp(req));
  }

  @Post('poll')
  @HttpCode(200)
  poll(@Body() dto: PollDto) {
    return this.web.poll(dto.request_id, dto.poll_token);
  }

  @Post('phone/start')
  @HttpCode(200)
  startPhone(@Req() req: Request, @Body() dto: PhoneStartDto, @Headers('user-agent') ua?: string) {
    return this.web.startPhone(dto.phone, ua, clientIp(req));
  }

  @Post('phone/verify')
  @HttpCode(200)
  verifyPhone(@Body() dto: PhoneVerifyDto) {
    return this.web.verifyPhone(dto.request_id, dto.poll_token, dto.code);
  }
}

/** Called by the bot only: /start login_<id> from the site's «Войти через Telegram». */
@ApiExcludeController()
@UseGuards(BotSecretGuard)
@Controller('internal/bot/customer-login')
export class BotCustomerLoginController {
  constructor(private readonly web: CustomerWebLoginService) {}

  @Post(':hex')
  @HttpCode(200)
  confirm(@Param('hex') hex: string, @Body() body: { from?: Partial<TelegramFrom> }) {
    const f = body.from ?? {};
    const from: TelegramFrom = {
      id: Number(f.id),
      first_name: String(f.first_name ?? '').slice(0, 64),
      last_name: f.last_name ? String(f.last_name).slice(0, 64) : undefined,
      username: f.username ? String(f.username).slice(0, 64) : undefined,
      language_code: f.language_code ? String(f.language_code).slice(0, 8) : undefined,
    };
    return this.web.confirmTelegram(hex, from);
  }
}
