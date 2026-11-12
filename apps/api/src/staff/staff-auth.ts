import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { staff_users } from '@prisma/client';
import type { Request } from 'express';
import { InitDataVerifier } from '../auth/init-data.verifier';
import { generateSessionToken, hashSessionToken } from '../auth/session-token';
import { PrismaService } from '../prisma/prisma.service';
import { can, type Permission } from './permissions';

export interface StaffContext {
  sessionId: string;
  staff: staff_users;
}

interface StaffRequest extends Request {
  staffAuth?: StaffContext;
}

/** Admin-panel session cookie in an ordinary browser (генплан, этап 3, D-56). */
export const SESSION_COOKIE = 'vitalo_staff';
export const DEVICE_COOKIE = 'vitalo_staff_device';
/** Header every cookie-authenticated change must carry: a page on another site cannot add it without CORS. */
export const CSRF_HEADER = 'x-vitalo-admin';

/** Reads one cookie from the Cookie header (no cookie-parser in this app). */
export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim()) || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

const SEEN_EVERY_MS = 5 * 60_000;
/** D-65 / аудит 4.8: auto sign-out after 30 days without activity. */
export const STAFF_IDLE_MS = 30 * 86_400_000;

/** Staff login: same Telegram initData as customers, then the Telegram id must be an active staff_users row. */
@Injectable()
export class StaffAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly initData: InitDataVerifier,
  ) {}

  async login(initData: string, ip: string | null = null) {
    const { user } = this.initData.verify(initData);
    const staff = await this.prisma.staff_users.findUnique({ where: { telegram_user_id: BigInt(user.id) } });
    if (!staff || staff.status !== 'active') throw new ForbiddenException('Not a staff member');

    const token = generateSessionToken();
    const ttlHours = Number(this.config.get('STAFF_SESSION_TTL_HOURS') ?? 12);
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
    await this.prisma.staff_sessions.create({
      data: { staff_user_id: staff.id, token_hash: hashSessionToken(token), expires_at: expiresAt, kind: 'telegram', device_name: 'Telegram', last_seen_at: new Date(), ip },
    });
    return { token, expires_at: expiresAt.toISOString(), staff: { id: staff.id, name: staff.name, role: staff.role, is_specialist: staff.is_specialist } };
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.staff_sessions.update({ where: { id: sessionId }, data: { revoked_at: new Date() } });
  }

  /** Admin action: sign an employee out everywhere (also done automatically on block). */
  async revokeAll(staffId: string): Promise<number> {
    const res = await this.prisma.staff_sessions.updateMany({
      where: { staff_user_id: staffId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    return res.count;
  }

  async findActiveSession(token: string): Promise<StaffContext | null> {
    const session = await this.prisma.staff_sessions.findUnique({
      where: { token_hash: hashSessionToken(token) },
      include: { staff_user: true },
    });
    // A blocked employee loses access immediately, whatever sessions they still hold (TZ §23).
    if (!session || session.revoked_at || session.expires_at <= new Date() || session.staff_user.status !== 'active') return null;
    // D-65 / аудит 4.8: a session not used for 30 days signs out by itself
    if (Date.now() - (session.last_seen_at ?? session.created_at).getTime() > STAFF_IDLE_MS) {
      await this.prisma.staff_sessions.update({ where: { id: session.id }, data: { revoked_at: new Date() } }).catch(() => undefined);
      return null;
    }
    // «Мои устройства» shows when a session was last used; written at most once per 5 minutes.
    if (!session.last_seen_at || Date.now() - session.last_seen_at.getTime() > SEEN_EVERY_MS) {
      await this.prisma.staff_sessions.update({ where: { id: session.id }, data: { last_seen_at: new Date() } }).catch(() => undefined);
    }
    return { sessionId: session.id, staff: session.staff_user };
  }
}

const PERMISSIONS_KEY = 'staffPermissions';
/** The endpoint needs ANY of these permissions (see permissions.ts). Without it: any active employee. */
export const RequirePermission = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    private readonly auth: StaffAuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<StaffRequest>();
    const [scheme, bearer] = (req.headers.authorization ?? '').split(' ');
    let token = scheme === 'Bearer' && bearer ? bearer : null;
    if (!token) {
      // Browser version (admin.vitalo.uz): HttpOnly cookie; changes need the admin header (CSRF protection).
      token = readCookie(req, SESSION_COOKIE);
      if (token && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.header(CSRF_HEADER) !== '1') {
        throw new ForbiddenException({ code: 'CSRF', message: 'Missing admin header' });
      }
    }
    if (!token) throw new UnauthorizedException();

    const auth = await this.auth.findActiveSession(token);
    if (!auth) throw new UnauthorizedException();

    const needed = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (needed && !needed.some((p) => can(auth.staff.role, p, auth.staff.is_specialist))) {
      throw new ForbiddenException({ code: 'FORBIDDEN_FOR_ROLE', message: `Role ${auth.staff.role} cannot do this` });
    }
    req.staffAuth = auth;
    return true;
  }
}

export const CurrentStaff = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): StaffContext => ctx.switchToHttp().getRequest<StaffRequest>().staffAuth!,
);
