import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, users } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthContext, toUserProfile, UserProfile } from './auth.types';
import { generateSessionToken, hashSessionToken } from './session-token';
import { InitDataError, validateInitData, ValidatedInitData } from './telegram-init-data';

export interface LoginResult {
  token: string;
  expires_at: string;
  is_new_user: boolean;
  user: UserProfile;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async loginWithTelegram(initData: string, deviceInfo?: string): Promise<LoginResult> {
    const data = this.verifyInitData(initData);
    const { user, isNew } = await this.upsertUser(data);
    if (user.status !== 'active') throw new ForbiddenException('Account is not active');

    const token = generateSessionToken();
    const ttlHours = Number(this.config.get('SESSION_TTL_HOURS') ?? 720);
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
    await this.prisma.user_sessions.create({
      data: {
        user_id: user.id,
        token_hash: hashSessionToken(token),
        device_info: deviceInfo?.slice(0, 255) ?? null,
        expires_at: expiresAt,
      },
    });

    // start_param (referral code) is validated but not processed yet: referral attribution is a later stage.
    return { token, expires_at: expiresAt.toISOString(), is_new_user: isNew, user: toUserProfile(user) };
  }

  async findActiveSession(token: string): Promise<AuthContext | null> {
    const session = await this.prisma.user_sessions.findUnique({
      where: { token_hash: hashSessionToken(token) },
      include: { user: true },
    });
    if (!session || session.revoked_at || session.expires_at <= new Date()) return null;
    if (session.user.status !== 'active') return null;
    return { sessionId: session.id, user: session.user };
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.user_sessions.update({ where: { id: sessionId }, data: { revoked_at: new Date() } });
  }

  private verifyInitData(initData: string): ValidatedInitData {
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

  private async upsertUser({ user: tg }: ValidatedInitData): Promise<{ user: users; isNew: boolean }> {
    const telegramUserId = BigInt(tg.id);
    const profile = { first_name: tg.first_name, last_name: tg.last_name ?? null, username: tg.username ?? null };

    const existing = await this.prisma.users.findUnique({ where: { telegram_user_id: telegramUserId } });
    if (existing) {
      const user = await this.prisma.users.update({ where: { id: existing.id }, data: profile });
      return { user, isNew: false };
    }

    try {
      const user = await this.prisma.users.create({
        data: {
          ...profile,
          telegram_user_id: telegramUserId,
          language: tg.language_code === 'uz' ? 'uz' : 'ru',
          bonus_account: { create: {} },
        },
      });
      return { user, isNew: true };
    } catch (e) {
      // Two parallel first logins: the other request created the user first.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const user = await this.prisma.users.findUniqueOrThrow({ where: { telegram_user_id: telegramUserId } });
        return { user, isNew: false };
      }
      throw e;
    }
  }
}
