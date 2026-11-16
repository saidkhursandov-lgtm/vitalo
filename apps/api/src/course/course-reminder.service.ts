import { Injectable, Logger, Module } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { isTashkentWorkingHours } from '../common/tashkent';
import { availableQty } from '../catalog/product.mapper';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { courseDays, courseWindow, daysLeft } from './course';

const DAY_MS = 86_400_000;
/** Longest course looked at: 2 years after the delivery. */
const LOOK_BACK_DAYS = 730;

const shortName = (p: { short_name_ru: string | null; short_name_uz: string | null; name_ru: string; name_uz: string | null }, lang: 'ru' | 'uz') =>
  (lang === 'uz' ? p.short_name_uz || p.name_uz || p.short_name_ru : p.short_name_ru) || p.name_ru;

export const courseDedupKey = (orderId: string, productId: string) => `course.ending:${orderId}:${productId}`;

/**
 * Release 4.2 «Курс заканчивается»: 5 days before the jars of a delivered order run out the customer gets one
 * message per order line (in the daytime), with «Повторить» (or «Сообщить о поступлении») and «Не напоминать».
 * Not sent: the course is unknown or short, the product was bought again later, the line went back, the customer
 * switched the reminders off.
 */
@Injectable()
export class CourseReminderService {
  private readonly logger = new Logger(CourseReminderService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @Interval('course-ending', 60 * 60_000)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const n = await this.run();
      if (n) this.logger.log(`Course reminders: ${n} queued`);
    } catch (e) {
      this.logger.error('Course reminders failed', e as Error);
    } finally {
      this.running = false;
    }
  }

  async run(now = new Date()): Promise<number> {
    if (!isTashkentWorkingHours(now)) return 0;
    const orders = await this.prisma.orders.findMany({
      where: {
        status: 'delivered',
        is_test: false,
        delivered_at: { gte: new Date(now.getTime() - LOOK_BACK_DAYS * DAY_MS), lte: now },
        user: { course_reminders: true, status: 'active' },
        items: { some: { product: { pack_count: { gt: 0 }, servings_per_day: { gt: 0 } } } },
      },
      select: {
        id: true,
        order_number: true,
        user_id: true,
        created_at: true,
        delivered_at: true,
        user: { select: { telegram_user_id: true, language: true } },
        items: {
          select: {
            qty: true,
            product_id: true,
            return_items: { where: { return: { status: { not: 'rejected' } } }, select: { id: true } },
            product: {
              select: {
                name_ru: true,
                name_uz: true,
                short_name_ru: true,
                short_name_uz: true,
                pack_count: true,
                servings_per_day: true,
                inventory: { select: { actual_qty: true, reserved_qty: true } },
              },
            },
          },
        },
      },
    });

    // the lines whose window is open now (two lines of one product in an order are one course)
    const due: { o: (typeof orders)[number]; productId: string; end: Date; item: (typeof orders)[number]['items'][number] }[] = [];
    for (const o of orders) {
      const jars = new Map<string, number>();
      for (const i of o.items) if (!i.return_items.length) jars.set(i.product_id, (jars.get(i.product_id) ?? 0) + i.qty);
      for (const [productId, qty] of jars) {
        const item = o.items.find((i) => i.product_id === productId)!;
        const w = courseWindow(o.delivered_at!, courseDays(qty, item.product.pack_count, item.product.servings_per_day));
        if (w && now >= w.from && now < w.end) due.push({ o, productId, end: w.end, item });
      }
    }
    if (!due.length) return 0;

    const sent = new Set(
      (await this.prisma.notifications.findMany({ where: { dedup_key: { in: due.map((d) => courseDedupKey(d.o.id, d.productId)) } }, select: { dedup_key: true } })).map((n) => n.dedup_key),
    );
    let queued = 0;
    for (const d of due) {
      const key = courseDedupKey(d.o.id, d.productId);
      if (sent.has(key)) continue;
      // bought again after this order (not cancelled): the new jars carry on, no reminder
      const again = await this.prisma.order_items.count({
        where: { product_id: d.productId, order: { user_id: d.o.user_id, created_at: { gt: d.o.created_at }, status: { notIn: ['cancelled', 'return'] } } },
      });
      if (again) continue;
      const lang = d.o.user.language === 'uz' ? 'uz' : 'ru';
      const inStock = availableQty(d.item.product.inventory) > 0;
      const ok = await this.notifications.toCustomer(this.prisma, {
        userId: d.o.user_id,
        chatId: d.o.user.telegram_user_id,
        orderId: d.o.id,
        productId: d.productId,
        template: 'course.ending',
        category: 'order',
        payload: {
          order_number: d.o.order_number,
          lang,
          product: shortName(d.item.product, lang),
          days: daysLeft(d.end, now),
          open_path: `/product/${d.productId}`,
          open_button: inStock ? 'repeat' : 'waitlist',
        },
        dedupKey: key,
      });
      if (ok) queued++;
    }
    return queued;
  }
}

@Module({ providers: [CourseReminderService], exports: [CourseReminderService] })
export class CourseModule {}
