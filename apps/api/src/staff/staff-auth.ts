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
import { StaffRole, staff_users } from '@prisma/client';
import type { Request } from 'express';
import { InitDataVerifier } from '../auth/init-data.verifier';
import { generateSessionToken, hashSessionToken } from '../auth/session-token';
import { PrismaService } from '../prisma/prisma.service';

export interface StaffContext {
  sessionId: string;
  staff: staff_users;
}

interface StaffRequest extends Request {
  staffAuth?: StaffContext;
}

/** Staff login: same Telegram initData as customers, then the Telegram id must be an active staff_users row. */
@Injectable()
export class StaffAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly initData: InitDataVerifier,
  ) {}

  async login(initData: string) {
    const { user } = this.initData.verify(initData);
    const staff = await this.prisma.staff_users.findUnique({ where: { telegram_user_id: BigInt(user.id) } });
    if (!staff || staff.status !== 'active') throw new ForbiddenException('Not a staff member');

    const token = generateSessionToken();
    const ttlHours = Number(this.config.get('STAFF_SESSION_TTL_HOURS') ?? 12);
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
    await this.prisma.staff_sessions.create({
      data: { staff_user_id: staff.id, token_hash: hashSessionToken(token), expires_at: expiresAt },
    });
    return { token, expires_at: expiresAt.toISOString(), staff: { id: staff.id, name: staff.name, role: staff.role } };
  }

  async findActiveSession(token: string): Promise<StaffContext | null> {
    const session = await this.prisma.staff_sessions.findUnique({
      where: { token_hash: hashSessionToken(token) },
      include: { staff_user: true },
    });
    // A blocked employee loses access immediately, whatever sessions they still hold (TZ §23).
    if (!session || session.revoked_at || session.expires_at <= new Date() || session.staff_user.status !== 'active') return null;
    return { sessionId: session.id, staff: session.staff_user };
  }
}

const ROLES_KEY = 'staffRoles';
/** Allowed roles for a staff endpoint; admin always passes. */
export const StaffRoles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    private readonly auth: StaffAuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<StaffRequest>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException();

    const auth = await this.auth.findActiveSession(token);
    if (!auth) throw new UnauthorizedException();

    const roles = this.reflector.getAllAndOverride<StaffRole[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles && auth.staff.role !== 'admin' && !roles.includes(auth.staff.role)) {
      throw new ForbiddenException('Insufficient role');
    }
    req.staffAuth = auth;
    return true;
  }
}

export const CurrentStaff = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): StaffContext => ctx.switchToHttp().getRequest<StaffRequest>().staffAuth!,
);
