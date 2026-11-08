import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  ForbiddenException,
  Get,
  GoneException,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController, ApiExcludeEndpoint, ApiProperty, ApiTags } from '@nestjs/swagger';
import { staff_users } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { BotSecretGuard } from '../bot-internal/bot-internal.module';
import { TELEGRAM_SENDER, type TelegramSender } from '../notifications/telegram-sender';
import { PrismaService } from '../prisma/prisma.service';
import { generateSessionToken, hashSessionToken } from '../auth/session-token';
import { AuditService } from './audit.service';
import { can, permissionsOf } from './permissions';
import { CSRF_HEADER, CurrentStaff, DEVICE_COOKIE, readCookie, SESSION_COOKIE, StaffContext, StaffGuard } from './staff-auth';

export { CSRF_HEADER, DEVICE_COOKIE, SESSION_COOKIE };

const LOGIN_WAIT_MS = 3 * 60_000; // the button in the bot works for 3 minutes
const WIDGET_MAX_AGE_S = 10 * 60; // the Telegram Login Widget answer is accepted for 10 minutes
const DEVICE_DAYS = 365;
export const BACKUP_CODES = 10;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** «Chrome, Windows» from the User-Agent — only to recognise one's own device in the list. */
export function deviceName(ua: string | undefined): string {
  const u = ua ?? '';
  const browser = /YaBrowser/.test(u)
    ? 'Яндекс Браузер'
    : /Edg\//.test(u)
      ? 'Edge'
      : /OPR\/|Opera/.test(u)
        ? 'Opera'
        : /Firefox\//.test(u)
          ? 'Firefox'
          : /Chrome\//.test(u)
            ? 'Chrome'
            : /Safari\//.test(u)
              ? 'Safari'
              : 'Браузер';
  const os = /Windows/.test(u)
    ? 'Windows'
    : /iPhone|iPad|iPod/.test(u)
      ? 'iOS'
      : /Android/.test(u)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(u)
          ? 'macOS'
          : /Linux/.test(u)
            ? 'Linux'
            : 'неизвестная система';
  return `${browser}, ${os}`;
}

/** The client IP behind nginx (X-Real-IP set by the proxy snippet), else the socket address. */
export const clientIp = (req: Request) => (req.header('x-real-ip') || req.ip || '').slice(0, 64) || null;

/** Telegram Login Widget check (core.telegram.org/widgets/login): HMAC-SHA256 with SHA256(bot token) as the key. */
export function checkWidgetAuth(data: Record<string, unknown>, botToken: string, nowS = Math.floor(Date.now() / 1000)): { id: bigint } | null {
  const hash = typeof data.hash === 'string' ? data.hash : '';
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const check = Object.keys(data)
    .filter((k) => k !== 'hash' && data[k] !== undefined && data[k] !== null)
    .sort()
    .map((k) => `${k}=${String(data[k])}`)
    .join('\n');
  const expected = createHmac('sha256', createHash('sha256').update(botToken).digest()).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;
  const authDate = Number(data.auth_date);
  if (!Number.isFinite(authDate) || nowS - authDate > WIDGET_MAX_AGE_S || authDate - nowS > 60) return null;
  if (!/^\d{1,20}$/.test(String(data.id))) return null;
  return { id: BigInt(String(data.id)) };
}

/** Backup code: 16 letters/digits without look-alikes, shown as XXXX-XXXX-XXXX-XXXX. ~80 bits. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newBackupCode(): string {
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % 32]).join('');
  return chars.match(/.{4}/g)!.join('-');
}
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A small in-memory limit of login attempts per IP (one API process). */
class Attempts {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  take(key: string) {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      throw new HttpException({ code: 'TOO_MANY_ATTEMPTS', message: 'Слишком много попыток входа. Попробуйте через 15 минут.' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    list.push(now);
    this.hits.set(key, list);
  }
}

/** The login endpoints are anonymous: they need the same header as cookie requests (no login from another site). */
@Injectable()
export class CsrfHeaderGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.switchToHttp().getRequest<Request>().header(CSRF_HEADER) !== '1') throw new ForbiddenException({ code: 'CSRF', message: 'Missing admin header' });
    return true;
  }
}

/**
 * Генплан, этап 3 (D-56): the admin panel in an ordinary browser. Telegram Login Widget proves who the person is;
 * a browser seen for the first time must be confirmed with a button in the bot; then a 30-day HttpOnly cookie session.
 * The owner (admin) keeps 10 one-time backup codes for when Telegram or the bot is down. The Telegram version of the
 * admin panel (initData, Bearer token) stays as it was.
 */
@Injectable()
export class StaffWebAuthService {
  private readonly log = new Logger('StaffWebAuth');
  private botUsername: string | null = null;
  readonly loginAttempts = new Attempts(20, 15 * 60_000);
  readonly codeAttempts = new Attempts(5, 15 * 60_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    @Inject(TELEGRAM_SENDER) private readonly sender: TelegramSender,
  ) {}

  sessionDays() {
    return Math.max(1, Number(this.config.get('STAFF_WEB_SESSION_DAYS') ?? 30));
  }

  /** The bot of the widget: TELEGRAM_BOT_USERNAME, or asked once from Telegram (getMe) with the same token. */
  async widgetBot(): Promise<string | null> {
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

  /** Step 1: the widget answered. Known confirmed browser → session at once; otherwise a request to the bot. */
  async login(data: Record<string, unknown>, deviceToken: string | null, ua: string | undefined, ip: string | null) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) throw new BadRequestException({ code: 'BOT_NOT_CONFIGURED', message: 'Бот не настроен' });
    const who = checkWidgetAuth(data, token);
    if (!who) throw new UnauthorizedException({ code: 'BAD_TELEGRAM_LOGIN', message: 'Telegram не подтвердил вход. Попробуйте ещё раз.' });
    const staff = await this.prisma.staff_users.findUnique({ where: { telegram_user_id: who.id } });
    if (!staff || staff.status !== 'active') throw new ForbiddenException({ code: 'NOT_STAFF', message: 'Этот Telegram-аккаунт не сотрудник VITALO или заблокирован.' });

    if (deviceToken) {
      const device = await this.prisma.staff_devices.findUnique({ where: { token_hash: hashSessionToken(deviceToken) } });
      if (device && !device.revoked_at && device.staff_user_id === staff.id) {
        await this.prisma.staff_devices.update({ where: { id: device.id }, data: { last_seen_at: new Date() } });
        const session = await this.createSession(staff, 'web', { deviceId: device.id, deviceName: device.name, ip });
        return { status: 'approved' as const, ...session };
      }
    }

    const poll = generateSessionToken();
    const name = deviceName(ua);
    const req = await this.prisma.staff_login_requests.create({
      data: { staff_user_id: staff.id, poll_hash: hashSessionToken(poll), device_name: name, ip, expires_at: new Date(Date.now() + LOGIN_WAIT_MS) },
    });
    try {
      await this.sender.sendMessage(staff.telegram_user_id, `Вход в админку VITALO с нового устройства: ${name}${ip ? `, IP ${ip}` : ''}.\nЕсли это вы — нажмите «Подтвердить». Кнопка работает 3 минуты.`, {
        buttons: [
          [
            { text: 'Подтвердить', data: `sl:ok:${req.id}` },
            { text: 'Это не я', data: `sl:no:${req.id}` },
          ],
        ],
      });
    } catch (e) {
      this.log.warn(`login confirmation not sent: ${(e as Error).message}`);
      throw new BadRequestException({ code: 'BOT_UNREACHABLE', message: 'Бот не смог отправить подтверждение. Откройте бота VITALO, нажмите «Старт» и попробуйте снова.' });
    }
    return { status: 'pending' as const, request_id: req.id, poll_token: poll, expires_at: req.expires_at };
  }

  /** Step 2 (the bot): the employee pressed «Подтвердить» or «Это не я». Only the same Telegram account may answer. */
  async decide(requestId: string, telegramId: unknown, approve: boolean) {
    const req = await this.prisma.staff_login_requests.findUnique({ where: { id: requestId }, include: { staff_user: true } });
    if (!req || String(req.staff_user.telegram_user_id) !== String(telegramId)) throw new NotFoundException({ code: 'NOT_FOUND' });
    if (req.status !== 'pending') return { result: req.status };
    if (req.expires_at <= new Date()) return { result: 'expired' };
    const status = approve ? 'approved' : 'denied';
    const updated = await this.prisma.staff_login_requests.updateMany({ where: { id: req.id, status: 'pending' }, data: { status, decided_at: new Date() } });
    if (!updated.count) return { result: 'already' };
    await this.audit.log({ staffId: req.staff_user_id, action: approve ? 'staff.login_confirmed' : 'staff.login_denied', entityType: 'staff_users', entityId: req.staff_user_id, after: { device: req.device_name, ip: req.ip } });
    if (approve && req.staff_user.role === 'admin') {
      await this.tellAdmins(`Вход администратора ${req.staff_user.name} в админку с нового устройства: ${req.device_name}${req.ip ? `, IP ${req.ip}` : ''}.`, req.staff_user_id);
    }
    if (!approve) {
      await this.tellAdmins(`Внимание: ${req.staff_user.name} нажал(а) «Это не я» на вход в админку (${req.device_name}${req.ip ? `, IP ${req.ip}` : ''}). Вход не выполнен. Проверьте доступ к Telegram этого сотрудника.`, req.staff_user_id);
    }
    return { result: status };
  }

  /** Step 3 (the page asks every 2 s): once approved, the browser gets the device and the session — exactly once. */
  async poll(requestId: string, pollToken: string, ip: string | null) {
    const req = await this.prisma.staff_login_requests.findUnique({ where: { id: requestId }, include: { staff_user: true } });
    if (!req || req.poll_hash !== hashSessionToken(pollToken)) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Запрос входа не найден' });
    if (req.status === 'denied') return { status: 'denied' as const };
    if (req.status === 'pending') return { status: req.expires_at <= new Date() ? ('expired' as const) : ('pending' as const) };
    if (req.session_issued_at) throw new GoneException({ code: 'ALREADY_USED', message: 'Этот вход уже выполнен' });
    if (req.staff_user.status !== 'active') throw new ForbiddenException({ code: 'NOT_STAFF' });
    const claimed = await this.prisma.staff_login_requests.updateMany({ where: { id: req.id, session_issued_at: null }, data: { session_issued_at: new Date() } });
    if (!claimed.count) throw new GoneException({ code: 'ALREADY_USED', message: 'Этот вход уже выполнен' });
    const deviceToken = generateSessionToken();
    const device = await this.prisma.staff_devices.create({ data: { staff_user_id: req.staff_user_id, token_hash: hashSessionToken(deviceToken), name: req.device_name, last_seen_at: new Date() } });
    const session = await this.createSession(req.staff_user, 'web', { deviceId: device.id, deviceName: device.name, ip });
    return { status: 'approved' as const, ...session, device_token: deviceToken };
  }

  /** Emergency entry of the owner: a one-time code; every use is told to all admins. */
  async loginWithCode(code: string, ua: string | undefined, ip: string | null) {
    const row = await this.prisma.staff_backup_codes.findUnique({ where: { code_hash: sha(normalizeCode(code)) }, include: { staff_user: true } });
    if (!row || row.used_at || row.revoked_at || row.staff_user.status !== 'active' || row.staff_user.role !== 'admin') {
      throw new UnauthorizedException({ code: 'BAD_CODE', message: 'Код не подходит или уже использован' });
    }
    const used = await this.prisma.staff_backup_codes.updateMany({ where: { id: row.id, used_at: null, revoked_at: null }, data: { used_at: new Date() } });
    if (!used.count) throw new UnauthorizedException({ code: 'BAD_CODE', message: 'Код не подходит или уже использован' });
    const name = deviceName(ua);
    const left = await this.prisma.staff_backup_codes.count({ where: { staff_user_id: row.staff_user_id, used_at: null, revoked_at: null } });
    await this.audit.log({ staffId: row.staff_user_id, action: 'staff.backup_code_used', entityType: 'staff_users', entityId: row.staff_user_id, after: { device: name, ip, codes_left: left } });
    await this.tellAdmins(`Вход в админку по резервному коду: ${row.staff_user.name}, ${name}${ip ? `, IP ${ip}` : ''}. Осталось кодов: ${left}.`);
    return this.createSession(row.staff_user, 'backup', { deviceId: null, deviceName: name, ip });
  }

  async createSession(staff: staff_users, kind: 'web' | 'backup', opts: { deviceId: string | null; deviceName: string; ip: string | null }) {
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + this.sessionDays() * 86_400_000);
    const s = await this.prisma.staff_sessions.create({
      data: { staff_user_id: staff.id, token_hash: hashSessionToken(token), expires_at: expiresAt, kind, device_id: opts.deviceId, device_name: opts.deviceName, ip: opts.ip, last_seen_at: new Date() },
    });
    await this.audit.log({ staffId: staff.id, action: 'staff.login', entityType: 'staff_users', entityId: staff.id, after: { kind, session_id: s.id, device: opts.deviceName, ip: opts.ip } });
    return {
      token,
      expires_at: expiresAt,
      staff: { id: staff.id, name: staff.name, role: staff.role, is_specialist: staff.is_specialist },
      permissions: permissionsOf(staff.role, staff.is_specialist),
    };
  }

  // ---------------------------------------------------------------- «Мои устройства»

  async sessions(me: StaffContext) {
    const rows = await this.prisma.staff_sessions.findMany({
      where: { staff_user_id: me.staff.id, revoked_at: null, expires_at: { gt: new Date() } },
      orderBy: [{ last_seen_at: { sort: 'desc', nulls: 'last' } }, { created_at: 'desc' }],
    });
    return rows.map((s) => ({
      id: s.id,
      kind: s.kind,
      device_name: s.device_name ?? (s.kind === 'telegram' ? 'Telegram' : 'Браузер'),
      ip: s.ip,
      created_at: s.created_at,
      last_seen_at: s.last_seen_at,
      expires_at: s.expires_at,
      current: s.id === me.sessionId,
    }));
  }

  /** «Выйти» on one line: the session ends and its browser has to be confirmed in the bot again. */
  async revokeSession(me: StaffContext, id: string) {
    const s = await this.prisma.staff_sessions.findFirst({ where: { id, staff_user_id: me.staff.id } });
    if (!s) throw new NotFoundException({ code: 'NOT_FOUND' });
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.staff_sessions.update({ where: { id }, data: { revoked_at: s.revoked_at ?? now } }),
      ...(s.device_id ? [this.prisma.staff_devices.updateMany({ where: { id: s.device_id, revoked_at: null }, data: { revoked_at: now } })] : []),
    ]);
    await this.audit.log({ staffId: me.staff.id, action: 'staff.session_revoked', entityType: 'staff_users', entityId: me.staff.id, after: { session_id: id, device: s.device_name } });
  }

  /** «Выйти везде»: every session and every confirmed browser of this employee, this one included. */
  async logoutEverywhere(me: StaffContext) {
    const now = new Date();
    const [sessions] = await this.prisma.$transaction([
      this.prisma.staff_sessions.updateMany({ where: { staff_user_id: me.staff.id, revoked_at: null }, data: { revoked_at: now } }),
      this.prisma.staff_devices.updateMany({ where: { staff_user_id: me.staff.id, revoked_at: null }, data: { revoked_at: now } }),
    ]);
    await this.audit.log({ staffId: me.staff.id, action: 'staff.logout_everywhere', entityType: 'staff_users', entityId: me.staff.id, after: { sessions: sessions.count } });
    return { sessions: sessions.count };
  }

  // ---------------------------------------------------------------- backup codes (admin)

  async backupStatus(me: StaffContext) {
    const rows = await this.prisma.staff_backup_codes.findMany({ where: { staff_user_id: me.staff.id, revoked_at: null }, select: { created_at: true, used_at: true } });
    return { total: rows.length, left: rows.filter((r) => !r.used_at).length, created_at: rows[0]?.created_at ?? null };
  }

  /** 10 new codes, shown once; the old ones stop working. */
  async newBackupCodes(me: StaffContext) {
    const codes = Array.from({ length: BACKUP_CODES }, newBackupCode);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.staff_backup_codes.updateMany({ where: { staff_user_id: me.staff.id, revoked_at: null, used_at: null }, data: { revoked_at: now } }),
      this.prisma.staff_backup_codes.createMany({ data: codes.map((c) => ({ staff_user_id: me.staff.id, code_hash: sha(normalizeCode(c)) })) }),
    ]);
    await this.audit.log({ staffId: me.staff.id, action: 'staff.backup_codes_created', entityType: 'staff_users', entityId: me.staff.id, after: { count: codes.length } });
    return { codes };
  }

  private async tellAdmins(text: string, except?: string) {
    const admins = await this.prisma.staff_users.findMany({ where: { role: 'admin', status: 'active', ...(except && { id: { not: except } }) } });
    for (const a of admins) await this.sender.sendMessage(a.telegram_user_id, text).catch((e: Error) => this.log.warn(`admin notice not sent: ${e.message}`));
  }
}

// ---------------------------------------------------------------- HTTP

export class WidgetLoginDto {
  @ApiProperty() @Type(() => Number) @IsInt() id!: number;
  @ApiProperty() @Type(() => Number) @IsInt() auth_date!: number;
  @ApiProperty() @IsString() @Matches(/^[0-9a-f]{64}$/) hash!: string;
  @IsOptional() @IsString() @MaxLength(256) first_name?: string;
  @IsOptional() @IsString() @MaxLength(256) last_name?: string;
  @IsOptional() @IsString() @MaxLength(64) username?: string;
  @IsOptional() @IsString() @MaxLength(1024) photo_url?: string;
}
export class PollDto {
  @ApiProperty() @IsString() @Matches(/^[0-9a-f-]{36}$/) request_id!: string;
  @ApiProperty() @IsString() @MaxLength(128) poll_token!: string;
}
export class BackupLoginDto {
  @ApiProperty({ example: 'ABCD-EFGH-JKLM-NPQR' }) @IsString() @MaxLength(40) code!: string;
}

/** Cookie options: HttpOnly, Secure, SameSite=Strict, only for the staff API. */
function setCookie(res: Response, name: string, value: string, maxAgeMs: number, path: string) {
  res.cookie(name, value, { httpOnly: true, secure: true, sameSite: 'strict', path, maxAge: maxAgeMs });
}
export function clearAuthCookies(res: Response, device = false) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'strict', path: '/api/staff' });
  if (device) res.clearCookie(DEVICE_COOKIE, { httpOnly: true, secure: true, sameSite: 'strict', path: '/api/staff/auth' });
}

@ApiTags('staff: auth')
@Controller('staff/auth/web')
export class StaffWebAuthController {
  constructor(private readonly web: StaffWebAuthService) {}

  /** What the login page needs: the bot of the Telegram Login Widget. */
  @Get('config')
  async config() {
    return { bot_username: await this.web.widgetBot(), session_days: this.web.sessionDays() };
  }

  @Post('login')
  @HttpCode(200)
  @UseGuards(CsrfHeaderGuard)
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() dto: WidgetLoginDto) {
    const ip = clientIp(req);
    this.web.loginAttempts.take(`login:${ip}`);
    const raw = { ...(req.body as Record<string, unknown>) }; // the exact fields Telegram signed
    const out = await this.web.login(raw, readCookie(req, DEVICE_COOKIE), req.header('user-agent'), ip);
    if (out.status === 'approved') {
      const { token, ...rest } = out;
      setCookie(res, SESSION_COOKIE, token, this.web.sessionDays() * 86_400_000, '/api/staff');
      return rest;
    }
    return out;
  }

  @Post('poll')
  @HttpCode(200)
  @UseGuards(CsrfHeaderGuard)
  async poll(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() dto: PollDto) {
    const out = await this.web.poll(dto.request_id, dto.poll_token, clientIp(req));
    if (out.status !== 'approved') return out;
    const { token, device_token, ...rest } = out;
    setCookie(res, SESSION_COOKIE, token, this.web.sessionDays() * 86_400_000, '/api/staff');
    setCookie(res, DEVICE_COOKIE, device_token, DEVICE_DAYS * 86_400_000, '/api/staff/auth');
    return rest;
  }

  @Post('backup-code')
  @HttpCode(200)
  @UseGuards(CsrfHeaderGuard)
  async backup(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() dto: BackupLoginDto) {
    const ip = clientIp(req);
    this.web.codeAttempts.take(`code:${ip}`);
    const { token, ...rest } = await this.web.loginWithCode(dto.code, req.header('user-agent'), ip);
    setCookie(res, SESSION_COOKIE, token, this.web.sessionDays() * 86_400_000, '/api/staff');
    return rest;
  }
}

/** «Мои устройства» and the owner's backup codes. */
@ApiTags('staff: auth')
@UseGuards(StaffGuard)
@Controller('staff/auth')
export class StaffDevicesController {
  constructor(private readonly web: StaffWebAuthService) {}

  @Get('sessions')
  sessions(@CurrentStaff() me: StaffContext) {
    return this.web.sessions(me);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revoke(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Res({ passthrough: true }) res: Response) {
    await this.web.revokeSession(me, id);
    if (id === me.sessionId) clearAuthCookies(res, true);
  }

  @Post('logout-everywhere')
  @HttpCode(200)
  async everywhere(@CurrentStaff() me: StaffContext, @Res({ passthrough: true }) res: Response) {
    const out = await this.web.logoutEverywhere(me);
    clearAuthCookies(res, true);
    return out;
  }

  @Get('backup-codes')
  backupStatus(@CurrentStaff() me: StaffContext) {
    if (!can(me.staff.role, 'staff.manage')) throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE' });
    return this.web.backupStatus(me);
  }

  @Post('backup-codes')
  @HttpCode(200)
  newCodes(@CurrentStaff() me: StaffContext) {
    if (!can(me.staff.role, 'staff.manage')) throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE' });
    return this.web.newBackupCodes(me);
  }
}

/** Called by the bot only: «Подтвердить» / «Это не я» under the login message. */
@ApiExcludeController()
@UseGuards(BotSecretGuard)
@Controller('internal/bot/staff-login')
export class BotStaffLoginController {
  constructor(private readonly web: StaffWebAuthService) {}

  @Post(':id/decision')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  decide(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: { telegram_id?: unknown; approve?: unknown }) {
    return this.web.decide(id, body.telegram_id, body.approve === true);
  }
}
