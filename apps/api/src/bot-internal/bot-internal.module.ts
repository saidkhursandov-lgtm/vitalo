import {
  BadRequestException,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  Param,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';

/** Settings keys the bot reads (editable in the `settings` table). */
export const BOT_SETTING_KEYS = { support: 'support_contact', aboutRu: 'about_ru', aboutUz: 'about_uz' } as const;

const DEFAULT_ABOUT_RU =
  'VITALO — интернет-магазин витаминов и БАДов с доставкой по всему Узбекистану. ' +
  'Только оригинальная продукция, понятные составы и бережная доставка.';
const DEFAULT_ABOUT_UZ =
  'VITALO — butun O‘zbekiston bo‘ylab yetkazib beriladigan vitaminlar va biologik faol qo‘shimchalar do‘koni. ' +
  'Faqat original mahsulotlar, tushunarli tarkib va ehtiyotkor yetkazib berish.';

/**
 * Only the bot process may call /api/internal/bot/*: it sends header `X-Bot-Secret` = BOT_API_SECRET
 * (both read from apps/api/.env). Compared in constant time; without a configured secret everything is refused.
 */
@Injectable()
export class BotSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.config.get<string>('BOT_API_SECRET');
    if (!expected || expected.length < 32) throw new ServiceUnavailableException('BOT_API_SECRET is not configured');
    const given = ctx.switchToHttp().getRequest<Request>().header('x-bot-secret') ?? '';
    const digest = (s: string) => createHash('sha256').update(s).digest();
    if (!timingSafeEqual(digest(given), digest(expected))) throw new UnauthorizedException();
    return true;
  }
}

function telegramId(raw: string): bigint {
  if (!/^\d{1,20}$/.test(raw)) throw new BadRequestException('telegram id must be digits');
  return BigInt(raw);
}

@ApiExcludeController()
@UseGuards(BotSecretGuard)
@Controller('internal/bot')
export class BotInternalController {
  constructor(private readonly prisma: PrismaService) {}

  /** What the bot shows in "Мои заказы" / "Мой профиль". Unknown users get { registered: false }. */
  @Get('users/:telegramId')
  async user(@Param('telegramId') raw: string) {
    const u = await this.prisma.users.findUnique({
      where: { telegram_user_id: telegramId(raw) },
      include: {
        bonus_account: true,
        orders: { orderBy: { created_at: 'desc' }, take: 5 },
        _count: { select: { orders: true, favorites: true, addresses: { where: { deleted_at: null } } } },
      },
    });
    if (!u || u.status !== 'active') return { registered: false, blocked: u?.status === 'blocked' };
    return {
      registered: true,
      blocked: false,
      first_name: u.first_name,
      language: u.language,
      bonus_balance_uzs: Number(u.bonus_account?.balance_uzs ?? 0n),
      orders_total: u._count.orders,
      favorites_count: u._count.favorites,
      addresses_count: u._count.addresses,
      orders: u.orders.map((o) => ({ id: o.id, order_number: o.order_number, status: o.status, total_uzs: Number(o.total_uzs), created_at: o.created_at })),
    };
  }

  /** For /admin: only active employees get the admin panel button. */
  @Get('staff/:telegramId')
  async staff(@Param('telegramId') raw: string) {
    const s = await this.prisma.staff_users.findUnique({ where: { telegram_user_id: telegramId(raw) } });
    return s && s.status === 'active' ? { is_staff: true, role: s.role, name: s.name } : { is_staff: false };
  }

  @Get('info')
  async info() {
    const rows = await this.prisma.settings.findMany({ where: { key: { in: Object.values(BOT_SETTING_KEYS) } } });
    const get = (key: string) => {
      const v = rows.find((r) => r.key === key)?.value;
      return typeof v === 'string' && v.trim() ? v : null;
    };
    return {
      support_contact: get(BOT_SETTING_KEYS.support),
      about_ru: get(BOT_SETTING_KEYS.aboutRu) ?? DEFAULT_ABOUT_RU,
      about_uz: get(BOT_SETTING_KEYS.aboutUz) ?? DEFAULT_ABOUT_UZ,
    };
  }
}

@Module({ controllers: [BotInternalController], providers: [BotSecretGuard] })
export class BotInternalModule {}
