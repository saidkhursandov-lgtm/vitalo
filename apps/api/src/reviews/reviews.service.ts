import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Prisma, ReviewStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { BonusService } from '../bonus/bonus.service';
import { isTashkentWorkingHours } from '../common/tashkent';
import { listImage } from '../catalog/product.mapper';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE, FileStorage, uploadDir } from '../storage/file-storage';
import { IMAGE_THUMB_PX, processProductImage } from '../storage/image-processing';
import {
  authorName,
  looksMedical,
  ratingAvg,
  REVIEW_ASK_AFTER_DAYS,
  REVIEW_ASK_WITHIN_DAYS,
  REVIEW_PHOTO_MAX_BYTES,
  REVIEW_PHOTO_TYPES,
  REVIEW_PHOTOS_MAX,
  REVIEW_REJECT_REASONS,
  REVIEW_TAGS,
  REVIEW_TEXT_MAX,
  REVIEW_TEXT_MIN,
  reviewBonus,
  ReviewRejectReason,
} from './review-rules';

type Tx = Prisma.TransactionClient;
const DAY_MS = 86_400_000;

export interface ReviewPhoto {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

export interface NewReview {
  order_id: string;
  product_id: string;
  rating: number;
  tags?: string[];
  text: string;
  show_name: boolean;
}

/** Private folder for the photos of reviews not yet published (like receipts: nginx does not serve it). */
export function reviewsDir(config: ConfigService): string {
  return resolve(config.get<string>('REVIEWS_DIR') ?? join(dirname(uploadDir(config)), 'reviews'));
}

const shortName = (p: { short_name_ru: string | null; short_name_uz: string | null; name_ru: string; name_uz: string | null }, lang: 'ru' | 'uz') =>
  lang === 'uz' ? (p.short_name_uz ?? p.name_uz ?? p.short_name_ru ?? p.name_ru) : (p.short_name_ru ?? p.name_ru);

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);
  private readonly dir: string;
  private asking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bonus: BonusService,
    private readonly notifications: NotificationsService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    config: ConfigService,
  ) {
    this.dir = reviewsDir(config);
  }

  // ───────────── customer ─────────────

  /** «Оценить»: products of the customer's delivered orders without a review yet (newest orders first). */
  async reviewable(userId: string, orderId?: string) {
    const orders = await this.prisma.orders.findMany({
      where: { user_id: userId, status: 'delivered', ...(orderId && { id: orderId }) },
      orderBy: { delivered_at: 'desc' },
      take: orderId ? 1 : 30,
      select: {
        id: true,
        order_number: true,
        delivered_at: true,
        items: { select: { product: { select: { id: true, name_ru: true, name_uz: true, short_name_ru: true, short_name_uz: true, media: { where: { media_type: 'image' }, orderBy: [{ is_main: 'desc' }, { sort_order: 'asc' }], take: 1 } } } } },
        reviews: { select: { product_id: true, status: true } },
      },
    });
    return orders.flatMap((o) => {
      const done = new Map(o.reviews.map((r) => [r.product_id, r.status]));
      const seen = new Set<string>();
      return o.items
        .filter((i) => !seen.has(i.product.id) && seen.add(i.product.id))
        .map((i) => ({
          order_id: o.id,
          order_number: o.order_number,
          delivered_at: o.delivered_at?.toISOString() ?? null,
          product_id: i.product.id,
          name_ru: i.product.short_name_ru ?? i.product.name_ru,
          name_uz: i.product.short_name_uz ?? i.product.name_uz,
          image: listImage(i.product.media[0]),
          /** null — not reviewed yet; a rejected review may be written again */
          review_status: done.get(i.product.id) ?? null,
        }));
    });
  }

  async create(userId: string, dto: NewReview, photos: ReviewPhoto[]) {
    const text = dto.text.trim();
    if (!Number.isInteger(dto.rating) || dto.rating < 1 || dto.rating > 5) throw new BadRequestException({ code: 'REVIEW_RATING', message: 'Оценка от 1 до 5' });
    if (text.length < REVIEW_TEXT_MIN || text.length > REVIEW_TEXT_MAX) {
      throw new BadRequestException({ code: 'REVIEW_TEXT', message: `Текст отзыва: от ${REVIEW_TEXT_MIN} до ${REVIEW_TEXT_MAX} знаков` });
    }
    const tags = [...new Set(dto.tags ?? [])];
    if (tags.some((t) => !(REVIEW_TAGS as readonly string[]).includes(t))) throw new BadRequestException({ code: 'REVIEW_TAGS', message: 'Неизвестная метка' });
    if (photos.length > REVIEW_PHOTOS_MAX) throw new BadRequestException({ code: 'REVIEW_PHOTOS', message: `Не больше ${REVIEW_PHOTOS_MAX} фото` });
    for (const p of photos) {
      if (!REVIEW_PHOTO_TYPES.includes(p.mimetype) || p.size > REVIEW_PHOTO_MAX_BYTES) {
        throw new BadRequestException({ code: 'REVIEW_PHOTO_TYPE', message: 'Фото: JPEG, PNG или WebP до 10 МБ' });
      }
    }

    const order = await this.prisma.orders.findFirst({
      where: { id: dto.order_id, user_id: userId },
      select: { id: true, status: true, items: { where: { product_id: dto.product_id }, select: { id: true } }, user: { select: { first_name: true, last_name: true, language: true } } },
    });
    if (!order || !order.items.length) throw new NotFoundException({ code: 'REVIEW_NOT_BOUGHT', message: 'Этого товара нет в ваших заказах' });
    if (order.status !== 'delivered') throw new UnprocessableEntityException({ code: 'REVIEW_NOT_DELIVERED', message: 'Отзыв можно оставить после доставки заказа' });

    // photos first (outside the transaction): sharp drops EXIF (the place and the phone), keeps 1200 + 400 px
    const id = randomUUID();
    const media: { private_key: string; width: number; height: number; sort: number }[] = [];
    for (const [sort, p] of photos.entries()) {
      let img;
      try {
        img = await processProductImage(p.buffer);
      } catch {
        throw new BadRequestException({ code: 'REVIEW_PHOTO_TYPE', message: 'Не удалось прочитать фото' });
      }
      const key = `${id}/${randomUUID()}`;
      await this.writePrivate(`${key}.webp`, img.main.webp);
      await this.writePrivate(`${key}.jpg`, img.main.jpeg);
      await this.writePrivate(`${key}-${IMAGE_THUMB_PX}.webp`, img.thumb.webp);
      await this.writePrivate(`${key}-${IMAGE_THUMB_PX}.jpg`, img.thumb.jpeg);
      media.push({ private_key: key, width: img.main.width, height: img.main.height, sort });
    }

    const lang = order.user.language === 'uz' ? 'uz' : 'ru';
    return this.prisma.$transaction(async (tx) => {
      const old = await tx.reviews.findUnique({ where: { order_id_product_id: { order_id: order.id, product_id: dto.product_id } } });
      if (old && old.status !== 'rejected') throw new ConflictException({ code: 'REVIEW_EXISTS', message: 'Отзыв об этом товаре уже есть' });
      const data = {
        rating: dto.rating,
        tags,
        text,
        show_name: dto.show_name,
        author_name: authorName(order.user, dto.show_name, lang),
        lang,
      } as const;
      // a rejected review is written again in the same row (one review per product of an order); its old photos go
      if (old) await tx.review_media.deleteMany({ where: { review_id: old.id } });
      const review = old
        ? await tx.reviews.update({
            where: { id: old.id },
            data: { ...data, status: 'pending', reject_reason: null, reject_note: null, moderated_by: null, moderated_at: null, created_at: new Date() },
          })
        : await tx.reviews.create({ data: { id, order_id: order.id, product_id: dto.product_id, user_id: userId, ...data } });
      if (media.length) await tx.review_media.createMany({ data: media.map((m) => ({ ...m, review_id: review.id })) });
      return { id: review.id, status: review.status };
    });
  }

  /** The customer's own reviews (orders show «На проверке» / «Опубликован»). */
  /** For the form: the bonus for a published review and how the name will look («Саидкомол Х.» / anonymous). */
  async formInfo(userId: string) {
    const [user, s] = await Promise.all([
      this.prisma.users.findUniqueOrThrow({ where: { id: userId }, select: { first_name: true, last_name: true, language: true } }),
      this.bonus.settings(),
    ]);
    const lang = user.language === 'uz' ? 'uz' : 'ru';
    return {
      bonus: s.enabled ? { plain_uzs: reviewBonus(s, 0), photo_uzs: reviewBonus(s, 1) } : null,
      author_name: authorName(user, true, lang),
      anonymous_name: authorName(user, false, lang),
    };
  }

  async mine(userId: string) {
    const rows = await this.prisma.reviews.findMany({ where: { user_id: userId }, orderBy: { created_at: 'desc' }, take: 100 });
    return rows.map((r) => ({
      id: r.id,
      order_id: r.order_id,
      product_id: r.product_id,
      rating: r.rating,
      status: r.status,
      reject_reason: r.reject_reason,
      created_at: r.created_at.toISOString(),
    }));
  }

  /** Published reviews of a product with the summary (average, count, stars 5→1). */
  async forProduct(productId: string, page = 1) {
    const size = 10;
    const product = await this.prisma.products.findUnique({ where: { id: productId }, select: { reviews_count: true, rating_sum: true } });
    if (!product) throw new NotFoundException('Product not found');
    const where = { product_id: productId, status: ReviewStatus.published };
    const [rows, dist] = await Promise.all([
      this.prisma.reviews.findMany({
        where,
        orderBy: { published_at: 'desc' },
        skip: (Math.max(1, page) - 1) * size,
        take: size,
        include: { media: { orderBy: { sort: 'asc' } } },
      }),
      this.prisma.reviews.groupBy({ by: ['rating'], where, _count: { _all: true } }),
    ]);
    const stars = [5, 4, 3, 2, 1].map((n) => dist.find((d) => d.rating === n)?._count._all ?? 0);
    return {
      summary: { avg: ratingAvg(product.rating_sum, product.reviews_count), count: product.reviews_count, stars },
      items: rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        tags: r.tags,
        text: r.text,
        author: r.author_name,
        lang: r.lang,
        verified: true,
        published_at: r.published_at?.toISOString() ?? null,
        photos: r.media.filter((m) => m.url).map((m) => ({ url: m.url!, url_jpeg: m.url_jpeg, thumb_url: m.thumb_url, thumb_url_jpeg: m.thumb_url_jpeg, width: m.width, height: m.height })),
        reply: r.reply_text ? { text: r.reply_text, at: r.replied_at?.toISOString() ?? null } : null,
      })),
      page: Math.max(1, page),
      pages: Math.max(1, Math.ceil(product.reviews_count / size)),
    };
  }

  // ───────────── staff ─────────────

  async staffList(status: ReviewStatus, page = 1) {
    const size = 30;
    const where = { status };
    const [total, rows, counts] = await Promise.all([
      this.prisma.reviews.count({ where }),
      this.prisma.reviews.findMany({
        where,
        orderBy: { created_at: status === 'pending' ? 'asc' : 'desc' },
        skip: (Math.max(1, page) - 1) * size,
        take: size,
        include: {
          media: { orderBy: { sort: 'asc' }, select: { id: true } },
          product: { select: { id: true, sku: true, name_ru: true, short_name_ru: true } },
          order: { select: { id: true, order_number: true, delivered_at: true } },
          user: { select: { id: true, first_name: true, last_name: true } },
          moderator: { select: { name: true } },
          replier: { select: { name: true } },
        },
      }),
      this.prisma.reviews.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const s = await this.bonus.settings();
    return {
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      total,
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        rating: r.rating,
        tags: r.tags,
        text: r.text,
        author: r.author_name,
        show_name: r.show_name,
        lang: r.lang,
        medical_hint: looksMedical(r.text),
        media: r.media.map((m) => m.id),
        product: { id: r.product.id, sku: r.product.sku, name: r.product.short_name_ru ?? r.product.name_ru },
        order: { id: r.order.id, number: r.order.order_number, delivered_at: r.order.delivered_at?.toISOString() ?? null },
        customer: { id: r.user.id, name: [r.user.first_name, r.user.last_name].filter(Boolean).join(' ') },
        bonus_uzs: r.status === 'pending' ? reviewBonus(s, r.media.length) : r.bonus_uzs,
        reject_reason: r.reject_reason,
        reject_note: r.reject_note,
        moderated_by: r.moderator?.name ?? null,
        moderated_at: r.moderated_at?.toISOString() ?? null,
        reply: r.reply_text ? { text: r.reply_text, by: r.replier?.name ?? null, at: r.replied_at?.toISOString() ?? null } : null,
        created_at: r.created_at.toISOString(),
      })),
    };
  }

  /** A photo for the moderator (JPEG from the private folder, or the public copy after publication). */
  async mediaFile(reviewId: string, mediaId: string): Promise<Buffer> {
    const m = await this.prisma.review_media.findFirst({ where: { id: mediaId, review_id: reviewId } });
    if (!m) throw new NotFoundException('Photo not found');
    return readFile(this.privatePath(`${m.private_key}.jpg`));
  }

  /**
   * «Опубликовать и начислить»: photos go to the public folder, the product's stars are counted, the bonus (3 000 /
   * 5 000) is posted once (key review:<id>), the customer gets a message. A hidden review comes back without a new bonus.
   */
  async publish(id: string, staffId: string) {
    const r0 = await this.prisma.reviews.findUnique({ where: { id }, include: { media: true } });
    if (!r0) throw new NotFoundException('Review not found');
    if (r0.status !== 'pending' && r0.status !== 'hidden') throw new ConflictException({ code: 'REVIEW_STATE', message: 'Отзыв уже обработан' });
    // public copies of the photos (idempotent: a second try reuses the stored urls)
    const urls = new Map<string, { url: string; url_jpeg: string; thumb_url: string; thumb_url_jpeg: string }>();
    for (const m of r0.media) {
      if (m.url) continue;
      const base = `reviews/${r0.product_id}/${randomUUID()}`;
      urls.set(m.id, {
        url: await this.storage.save(`${base}.webp`, await readFile(this.privatePath(`${m.private_key}.webp`)), 'image/webp'),
        url_jpeg: await this.storage.save(`${base}.jpg`, await readFile(this.privatePath(`${m.private_key}.jpg`)), 'image/jpeg'),
        thumb_url: await this.storage.save(`${base}-${IMAGE_THUMB_PX}.webp`, await readFile(this.privatePath(`${m.private_key}-${IMAGE_THUMB_PX}.webp`)), 'image/webp'),
        thumb_url_jpeg: await this.storage.save(`${base}-${IMAGE_THUMB_PX}.jpg`, await readFile(this.privatePath(`${m.private_key}-${IMAGE_THUMB_PX}.jpg`)), 'image/jpeg'),
      });
    }
    const s = await this.bonus.settings();
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: ReviewStatus }[]>`SELECT status FROM reviews WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked.status !== 'pending' && locked.status !== 'hidden') throw new ConflictException({ code: 'REVIEW_STATE', message: 'Отзыв уже обработан' });
      const first = locked.status === 'pending';
      for (const [mediaId, u] of urls) await tx.review_media.update({ where: { id: mediaId }, data: u });
      const now = new Date();
      let bonusUzs = r0.bonus_uzs;
      let balance: number | null = null;
      if (first) {
        const amount = reviewBonus(s, r0.media.length);
        const posted = await this.bonus.post(tx, { userId: r0.user_id, op: 'review', amount, ref: `review:${id}`, orderId: r0.order_id, reason: `Отзыв о товаре${r0.media.length ? ' с фото' : ''}`, staffId, activity: true });
        bonusUzs = posted?.amount_uzs ?? 0;
        balance = posted?.balance_uzs ?? null;
      }
      const review = await tx.reviews.update({
        where: { id },
        data: { status: 'published', published_at: r0.published_at ?? now, moderated_by: staffId, moderated_at: now, bonus_uzs: bonusUzs },
      });
      await this.countStars(tx, r0.product_id, +1, r0.rating);
      if (first) await this.notify(tx, review.id, 'review.published', { bonus_uzs: bonusUzs, balance_uzs: balance ?? undefined });
      return { id, status: review.status, bonus_uzs: bonusUzs, first };
    });
  }

  async reject(id: string, staffId: string, reason: ReviewRejectReason, note?: string) {
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: ReviewStatus }[]>`SELECT status FROM reviews WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked) throw new NotFoundException('Review not found');
      if (locked.status !== 'pending') throw new ConflictException({ code: 'REVIEW_STATE', message: 'Отклонить можно только отзыв на проверке' });
      await tx.reviews.update({ where: { id }, data: { status: 'rejected', reject_reason: reason, reject_note: note?.trim() || null, moderated_by: staffId, moderated_at: new Date() } });
      await this.notify(tx, id, 'review.rejected', {});
      return { id, status: 'rejected' as const };
    });
  }

  /** «Скрыть»: off the product card, the bonus stays; never deleted. */
  async hide(id: string, staffId: string) {
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: ReviewStatus; product_id: string; rating: number }[]>`SELECT status, product_id, rating FROM reviews WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked) throw new NotFoundException('Review not found');
      if (locked.status !== 'published') throw new ConflictException({ code: 'REVIEW_STATE', message: 'Скрыть можно только опубликованный отзыв' });
      await tx.reviews.update({ where: { id }, data: { status: 'hidden', moderated_by: staffId, moderated_at: new Date() } });
      await this.countStars(tx, locked.product_id, -1, locked.rating);
      return { id, status: 'hidden' as const };
    });
  }

  /** The specialist's answer under the review (empty text removes it). */
  async reply(id: string, staffId: string, text: string) {
    const t = text.trim();
    const r = await this.prisma.reviews.findUnique({ where: { id }, select: { id: true } });
    if (!r) throw new NotFoundException('Review not found');
    await this.prisma.reviews.update({ where: { id }, data: t ? { reply_text: t, replied_by: staffId, replied_at: new Date() } : { reply_text: null, replied_by: null, replied_at: null } });
    return { id, reply: t || null };
  }

  /** For the admin menu badge. */
  pendingCount() {
    return this.prisma.reviews.count({ where: { status: 'pending' } });
  }

  // ───────────── «Как вам …? Оставьте отзыв» ─────────────

  @Interval('review-ask', 60 * 60_000)
  async tick() {
    if (this.asking) return;
    this.asking = true;
    try {
      const n = await this.runAsk();
      if (n) this.logger.log(`Reviews: ${n} requests queued`);
    } catch (e) {
      this.logger.error('Review requests failed', e as Error);
    } finally {
      this.asking = false;
    }
  }

  /**
   * Orders delivered 3–14 days ago, not asked yet, whose customer did not switch the requests off: one message per
   * order (in the daytime only) when something of it is still not reviewed.
   */
  async runAsk(now = new Date()): Promise<number> {
    if (!isTashkentWorkingHours(now)) return 0;
    const s = await this.bonus.settings();
    const orders = await this.prisma.orders.findMany({
      where: {
        status: 'delivered',
        review_asked_at: null,
        is_test: false,
        delivered_at: { lte: new Date(now.getTime() - REVIEW_ASK_AFTER_DAYS * DAY_MS), gte: new Date(now.getTime() - REVIEW_ASK_WITHIN_DAYS * DAY_MS) },
        user: { review_requests: true, status: 'active' },
      },
      take: 200,
      select: {
        id: true,
        order_number: true,
        user_id: true,
        user: { select: { telegram_user_id: true, language: true } },
        items: { select: { product: { select: { id: true, name_ru: true, name_uz: true, short_name_ru: true, short_name_uz: true } } } },
        reviews: { select: { product_id: true } },
      },
    });
    let queued = 0;
    for (const o of orders) {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.orders.updateMany({ where: { id: o.id, review_asked_at: null }, data: { review_asked_at: now } });
        if (!claimed.count) return;
        const done = new Set(o.reviews.map((r) => r.product_id));
        const left = [...new Map(o.items.filter((i) => !done.has(i.product.id)).map((i) => [i.product.id, i.product])).values()];
        if (!left.length) return;
        const lang = o.user.language === 'uz' ? 'uz' : 'ru';
        const names = left.slice(0, 2).map((p) => shortName(p, lang));
        const product = left.length > 2 ? `${names.join(', ')}${lang === 'uz' ? ' va boshqalar' : ' и другие товары'}` : names.join(lang === 'uz' ? ' va ' : ' и ');
        const sent = await this.notifications.toCustomer(tx, {
          userId: o.user_id,
          chatId: o.user.telegram_user_id,
          orderId: o.id,
          template: 'review.ask',
          category: 'order',
          payload: { order_number: o.order_number, lang, product, bonus_uzs: s.enabled ? Math.max(s.review_uzs, s.review_photo_uzs) : 0, open_path: `/review/${o.id}`, open_button: 'review' },
          dedupKey: `review.ask:${o.id}`,
        });
        if (sent) queued++;
      });
    }
    return queued;
  }

  // ───────────── helpers ─────────────

  private async countStars(tx: Tx, productId: string, sign: 1 | -1, rating: number) {
    await tx.products.update({ where: { id: productId }, data: { reviews_count: { increment: sign }, rating_sum: { increment: sign * rating } } });
  }

  private async notify(tx: Tx, reviewId: string, template: 'review.published' | 'review.rejected', extra: { bonus_uzs?: number; balance_uzs?: number }) {
    const r = await tx.reviews.findUniqueOrThrow({
      where: { id: reviewId },
      select: {
        order_id: true,
        product_id: true,
        reject_reason: true,
        order: { select: { order_number: true } },
        product: { select: { name_ru: true, name_uz: true, short_name_ru: true, short_name_uz: true } },
        user: { select: { id: true, telegram_user_id: true, language: true } },
      },
    });
    const lang = r.user.language === 'uz' ? 'uz' : 'ru';
    const reason = r.reject_reason ? REVIEW_REJECT_REASONS[r.reject_reason as ReviewRejectReason]?.[lang] : undefined;
    await this.notifications.toCustomer(tx, {
      userId: r.user.id,
      chatId: r.user.telegram_user_id,
      orderId: r.order_id,
      productId: r.product_id,
      template,
      category: 'order',
      payload: {
        order_number: r.order.order_number,
        lang,
        product: shortName(r.product, lang),
        ...(extra.bonus_uzs && { bonus_uzs: extra.bonus_uzs, balance_uzs: extra.balance_uzs }),
        ...(reason && { reason }),
        open_path: template === 'review.published' ? `/product/${r.product_id}` : `/review/${r.order_id}`,
        open_button: template === 'review.published' ? 'product' : 'review',
      },
      dedupKey: `${template}:${reviewId}:${Date.now()}`,
    });
  }

  private privatePath(key: string): string {
    const path = resolve(join(this.dir, key));
    if (!path.startsWith(this.dir)) throw new Error('Invalid review file key');
    return path;
  }

  private async writePrivate(key: string, data: Buffer) {
    const path = this.privatePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
}
