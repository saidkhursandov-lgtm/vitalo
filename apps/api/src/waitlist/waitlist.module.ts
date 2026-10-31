import { ConflictException, Controller, Delete, Get, HttpCode, Injectable, Logger, Module, NotFoundException, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AnalyticsModule, AnalyticsService } from '../analytics/analytics.module';
import { AuthModule } from '../auth/auth.module';
import { AuthContext } from '../auth/auth.types';
import { CurrentAuth, SessionGuard } from '../auth/session.guard';
import { availableQty } from '../catalog/product.mapper';
import { NotificationsService } from '../notifications/notifications.service';
import { SystemErrorsService } from '../notifications/system-errors';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVE, productTitle, waitingCount } from './waitlist';

/**
 * 2.4: «Сообщить о поступлении». A customer subscribes to a product that is out of stock; admins and managers get a
 * message in the bot; when the product is available again, a job writes «… снова в наличии» once per subscription.
 */
@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly analytics: AnalyticsService,
    private readonly errors: SystemErrorsService,
  ) {}

  /** Products the customer is waiting for (to draw «Вы в списке ожидания»). */
  async ids(userId: string): Promise<string[]> {
    const rows = await this.prisma.product_waitlist.findMany({ where: { user_id: userId, ...ACTIVE }, select: { product_id: true } });
    return rows.map((r) => r.product_id);
  }

  /**
   * One row per customer and product: pressing again while waiting changes nothing ('already'); a notified or cancelled
   * row is reopened. Staff hear about a new row or a reopened notified one — not about the bell switched off and on again.
   */
  async subscribe(userId: string, productId: string): Promise<{ status: 'subscribed' | 'already' }> {
    const product = await this.prisma.products.findFirst({ where: { id: productId, status: 'active' }, include: { inventory: true } });
    if (!product) throw new NotFoundException('Product not found');
    if (availableQty(product.inventory) > 0) throw new ConflictException({ code: 'IN_STOCK', message: 'The product is in stock' });

    const user = await this.prisma.users.findUniqueOrThrow({ where: { id: userId } });
    const result = await this.prisma.$transaction(async (tx) => {
      const row = await tx.product_waitlist.findUnique({ where: { product_id_user_id: { product_id: productId, user_id: userId } } });
      if (row && !row.notified_at && !row.cancelled_at) return 'already' as const;
      if (row) await tx.product_waitlist.update({ where: { id: row.id }, data: { notified_at: null, cancelled_at: null, created_at: new Date(), phone: user.phone } });
      else await tx.product_waitlist.create({ data: { product_id: productId, user_id: userId, phone: user.phone } });
      if (row?.cancelled_at && !row.notified_at) return 'subscribed' as const;
      const count = await waitingCount(tx, productId);
      await this.notifications.toStaffRoles(tx, ['admin', 'manager'], 'staff.waitlist_new', {
        order_number: '',
        product: `${product.sku} · ${productTitle(product, 'ru')}`,
        count,
        admin_path: `/waitlist/${productId}`,
      });
      return 'subscribed' as const;
    });
    if (result === 'subscribed') await this.analytics.track(userId, 'waitlist_subscribe', { product_id: productId });
    return { status: result };
  }

  /** 2.4 patch: the bell switched off. The row is only marked (never deleted); no message will be sent for it. */
  async unsubscribe(userId: string, productId: string): Promise<{ status: 'cancelled' | 'not_waiting' }> {
    const done = await this.prisma.product_waitlist.updateMany({ where: { product_id: productId, user_id: userId, ...ACTIVE }, data: { cancelled_at: new Date() } });
    if (!done.count) return { status: 'not_waiting' };
    await this.analytics.track(userId, 'waitlist_unsubscribe', { product_id: productId });
    return { status: 'cancelled' };
  }

  @Interval('waitlist', 60_000)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const n = await this.notifyOnce();
      if (n) this.logger.log(`Back in stock: ${n} customer(s) notified`);
    } catch (e) {
      this.logger.error('Waitlist job failed', e as Error);
      await this.errors.record({ level: 'error', service: 'waitlist', message: `Waitlist job failed: ${(e as Error).message}`, context: { job: 'waitlist' } });
    } finally {
      this.running = false;
    }
  }

  /**
   * Every product someone waits for is checked; when it is available again, each waiting customer gets one message
   * with a button that opens the product, and the row is marked notified (never a second message for the same row).
   * Returns how many customers were notified. Exposed for tests and manual runs.
   */
  async notifyOnce(now = new Date()): Promise<number> {
    const waiting = await this.prisma.product_waitlist.groupBy({ by: ['product_id'], where: ACTIVE });
    if (!waiting.length) return 0;
    const products = await this.prisma.products.findMany({
      where: { id: { in: waiting.map((w) => w.product_id) }, status: 'active' },
      include: { inventory: true },
    });
    let notified = 0;
    for (const p of products.filter((x) => availableQty(x.inventory) > 0)) {
      const rows = await this.prisma.product_waitlist.findMany({ where: { product_id: p.id, ...ACTIVE }, include: { user: true } });
      for (const row of rows) {
        const sent = await this.prisma.$transaction(async (tx) => {
          // claim the row first: a second API instance or a parallel run skips it
          const claimed = await tx.product_waitlist.updateMany({ where: { id: row.id, ...ACTIVE }, data: { notified_at: now } });
          if (!claimed.count) return false;
          if (row.user.status !== 'active' || row.user.deleted_at) return false;
          const lang = row.user.language === 'uz' ? 'uz' : 'ru';
          await tx.notifications.create({
            data: {
              user_id: row.user_id,
              chat_id: row.user.telegram_user_id,
              kind: 'service', // the customer asked for this message
              template: 'waitlist.back_in_stock',
              payload: { order_number: '', product: productTitle(p, lang), open_path: `/product/${p.id}`, open_button: 'product', lang },
            },
          });
          return true;
        });
        if (sent) {
          notified++;
          await this.analytics.track(row.user_id, 'waitlist_notified', { product_id: p.id });
        }
      }
    }
    return notified;
  }
}

@ApiTags('waitlist')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('waitlist')
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  /** Product ids the customer is waiting for. */
  @Get('ids')
  ids(@CurrentAuth() auth: AuthContext) {
    return this.waitlist.ids(auth.user.id);
  }

  /** «Сообщить о поступлении»: 409 IN_STOCK when the product can be bought right now. */
  @Put(':productId')
  @HttpCode(200)
  subscribe(@CurrentAuth() auth: AuthContext, @Param('productId', new ParseUUIDPipe()) productId: string) {
    return this.waitlist.subscribe(auth.user.id, productId);
  }

  /** 2.4 patch: «Отменить» — the subscription is marked cancelled, not deleted. */
  @Delete(':productId')
  @HttpCode(200)
  unsubscribe(@CurrentAuth() auth: AuthContext, @Param('productId', new ParseUUIDPipe()) productId: string) {
    return this.waitlist.unsubscribe(auth.user.id, productId);
  }
}

@Module({ imports: [AuthModule, AnalyticsModule], controllers: [WaitlistController], providers: [WaitlistService], exports: [WaitlistService] })
export class WaitlistModule {}
