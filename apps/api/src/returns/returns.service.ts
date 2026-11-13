import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, ReturnStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { BonusService } from '../bonus/bonus.service';
import { listImage } from '../catalog/product.mapper';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { OrderUnitsService } from '../orders/order-units.service';
import { PrismaService } from '../prisma/prisma.service';
import { uploadDir } from '../storage/file-storage';
import { processProductImage } from '../storage/image-processing';
import {
  bonusShare,
  lineShare,
  OpenReturnReason,
  RefundMethod,
  RETURN_COMMENT_MAX,
  RETURN_DAYS,
  RETURN_PHOTO_MAX_BYTES,
  RETURN_PHOTO_TYPES,
  RETURN_PHOTOS_MAX,
  RETURN_PHOTOS_MIN,
  RETURN_REASON_TEXT,
  RETURN_REASONS_OPEN,
} from './return-rules';

type Tx = Prisma.TransactionClient;
const DAY_MS = 86_400_000;
const TX = { maxWait: 10_000, timeout: 20_000 };
/** A return still in work: its jars cannot be asked for again, and a second request waits for its decision. */
const ACTIVE: ReturnStatus[] = ['requested', 'approved'];
/** Jars counted as returned (asked, approved or paid back). */
const COUNTED: ReturnStatus[] = ['requested', 'approved', 'refunded', 'closed'];

export interface ReturnPhoto {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

export interface NewReturn {
  order_id: string;
  reason: string;
  comment?: string;
  items: { order_item_id: string; qty: number }[];
}

/** Private folder for the photos of returns (like receipts: nginx does not serve it). */
export function returnsDir(config: ConfigService): string {
  return resolve(config.get<string>('RETURNS_DIR') ?? join(dirname(uploadDir(config)), 'returns'));
}

/**
 * 3.10-В: «Вернуть товар» from a delivered order (14 days, a damaged or a wrong item, photos) → «Возвраты» in the
 * admin: approve with the amount / reject with the reason → «Деньги возвращены». The whole order returned goes the
 * existing way of «Возврат» (units on check, all bonuses back); a part — the order stays delivered, the bonuses of
 * the returned lines are taken back / given back by their share.
 */
@Injectable()
export class ReturnsService {
  private readonly dir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bonus: BonusService,
    private readonly notifications: NotificationsService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly units: OrderUnitsService,
    config: ConfigService,
  ) {
    this.dir = returnsDir(config);
  }

  // ───────────── customer ─────────────

  /** The order's lines that may still be returned, the deadline and the requests already sent. */
  async forOrder(userId: string, orderId: string, now = new Date()) {
    const order = await this.prisma.orders.findFirst({
      where: { id: orderId, user_id: userId },
      select: {
        id: true,
        order_number: true,
        status: true,
        delivered_at: true,
        items: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            qty: true,
            paid_line_total_uzs: true,
            name_ru_snapshot: true,
            product: { select: { name_ru: true, name_uz: true, short_name_ru: true, short_name_uz: true, media: { where: { media_type: 'image' }, orderBy: [{ is_main: 'desc' }, { sort_order: 'asc' }], take: 1 } } },
          },
        },
        returns: { orderBy: { created_at: 'desc' }, include: { items: true } },
      },
    });
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    const taken = this.takenQty(order.returns);
    const deadline = order.delivered_at ? new Date(order.delivered_at.getTime() + RETURN_DAYS * DAY_MS) : null;
    const active = order.returns.find((r) => ACTIVE.includes(r.status));
    const lines = order.items.map((i) => ({
      order_item_id: i.id,
      name_ru: i.product.short_name_ru ?? i.product.name_ru ?? i.name_ru_snapshot,
      name_uz: i.product.short_name_uz ?? i.product.name_uz,
      image: listImage(i.product.media[0]),
      qty: i.qty,
      max_qty: Math.max(0, i.qty - (taken.get(i.id) ?? 0)),
      unit_paid_uzs: lineShare(Number(i.paid_line_total_uzs), i.qty, 1),
    }));
    const block =
      order.status !== 'delivered' ? 'RETURN_NOT_DELIVERED' : !deadline || now > deadline ? 'RETURN_TOO_LATE' : active ? 'RETURN_ACTIVE' : lines.every((l) => l.max_qty === 0) ? 'RETURN_NOTHING_LEFT' : null;
    return {
      order_id: order.id,
      order_number: order.order_number,
      deadline: deadline?.toISOString() ?? null,
      days: RETURN_DAYS,
      can_request: block === null,
      blocked: block,
      reasons: RETURN_REASONS_OPEN,
      lines,
      returns: order.returns.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        created_at: r.created_at.toISOString(),
        refund_amount_uzs: r.refund_amount_uzs == null ? null : Number(r.refund_amount_uzs),
        reject_reason: r.reject_reason,
        refunded_at: r.refunded_at?.toISOString() ?? null,
        items: r.items.map((x) => ({ order_item_id: x.order_item_id, qty: x.qty })),
      })),
    };
  }

  async create(userId: string, dto: NewReturn, photos: ReturnPhoto[], now = new Date()) {
    if (!(RETURN_REASONS_OPEN as readonly string[]).includes(dto.reason)) throw new BadRequestException({ code: 'RETURN_REASON', message: 'Причина: товар повреждён или привезли не тот товар' });
    const comment = dto.comment?.trim() || null;
    if (comment && comment.length > RETURN_COMMENT_MAX) throw new BadRequestException({ code: 'RETURN_COMMENT', message: `Комментарий до ${RETURN_COMMENT_MAX} знаков` });
    const items = dto.items.filter((i) => i.qty > 0);
    if (!items.length || items.some((i) => !Number.isInteger(i.qty))) throw new BadRequestException({ code: 'RETURN_ITEMS', message: 'Выберите товар и количество' });
    if (new Set(items.map((i) => i.order_item_id)).size !== items.length) throw new BadRequestException({ code: 'RETURN_ITEMS', message: 'Товар выбран дважды' });
    if (photos.length < RETURN_PHOTOS_MIN || photos.length > RETURN_PHOTOS_MAX) {
      throw new BadRequestException({ code: 'RETURN_PHOTOS', message: `Приложите от ${RETURN_PHOTOS_MIN} до ${RETURN_PHOTOS_MAX} фото` });
    }
    for (const p of photos) {
      if (!RETURN_PHOTO_TYPES.includes(p.mimetype) || p.size > RETURN_PHOTO_MAX_BYTES) throw new BadRequestException({ code: 'RETURN_PHOTO_TYPE', message: 'Фото: JPEG, PNG или WebP до 10 МБ' });
    }
    // the first check outside the transaction (no files are written for a request that cannot be sent)
    const view = await this.forOrder(userId, dto.order_id, now);
    if (!view.can_request) throw this.blockedError(view.blocked!);

    const id = randomUUID();
    const keys: string[] = [];
    for (const p of photos) {
      let img;
      try {
        img = await processProductImage(p.buffer); // drops EXIF (the place and the phone)
      } catch {
        throw new BadRequestException({ code: 'RETURN_PHOTO_TYPE', message: 'Не удалось прочитать фото' });
      }
      const key = `${id}/${randomUUID()}.jpg`;
      await this.writePrivate(key, img.main.jpeg);
      keys.push(key);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const order = await this.lifecycle.lockOrder(tx, dto.order_id);
      if (order.user_id !== userId) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
      // again under the lock: two taps never make two requests
      const fresh = await this.forOrder(userId, dto.order_id, now);
      if (!fresh.can_request) throw this.blockedError(fresh.blocked!);
      const lines = new Map(fresh.lines.map((l) => [l.order_item_id, l]));
      const rows = await tx.order_items.findMany({ where: { order_id: order.id, id: { in: items.map((i) => i.order_item_id) } }, select: { id: true, qty: true, paid_line_total_uzs: true } });
      if (rows.length !== items.length) throw new BadRequestException({ code: 'RETURN_ITEMS', message: 'Этого товара нет в заказе' });
      for (const i of items) {
        if (i.qty > (lines.get(i.order_item_id)?.max_qty ?? 0)) throw new BadRequestException({ code: 'RETURN_QTY', message: 'Столько банок вернуть нельзя' });
      }
      const all = await tx.order_items.findMany({ where: { order_id: order.id }, select: { id: true, qty: true } });
      const prior = fresh.returns.some((r) => r.status !== 'rejected');
      const full = !prior && all.every((l) => items.find((i) => i.order_item_id === l.id)?.qty === l.qty);
      const shares = items.map((i) => {
        const row = rows.find((r) => r.id === i.order_item_id)!;
        return { order_item_id: i.order_item_id, qty: i.qty, refund_amount_uzs: BigInt(lineShare(Number(row.paid_line_total_uzs), row.qty, i.qty)) };
      });
      const r = await tx.returns.create({
        data: {
          id,
          order_id: order.id,
          user_id: userId,
          reason: dto.reason as OpenReturnReason,
          comment,
          full_order: full,
          items: { create: shares },
          media: { create: keys.map((url) => ({ url })) },
        },
      });
      const total = shares.reduce((s, x) => s + Number(x.refund_amount_uzs), 0);
      await this.notifications.toStaffRoles(tx, ['admin', 'manager'], 'staff.return_new', {
        order_number: order.order_number,
        reason: RETURN_REASON_TEXT[dto.reason]?.ru ?? dto.reason,
        total_uzs: total,
        admin_path: `/returns?status=requested`,
      });
      await this.customerMessage(tx, r.id, 'return.received');
      return r;
    }, TX);
    return { id: created.id, status: created.status };
  }

  // ───────────── staff ─────────────

  async staffList(status: ReturnStatus, page = 1) {
    const size = 30;
    const where = { status, order: { is_test: false } };
    const [total, rows, counts] = await Promise.all([
      this.prisma.returns.count({ where }),
      this.prisma.returns.findMany({
        where,
        orderBy: { created_at: status === 'requested' ? 'asc' : 'desc' },
        skip: (Math.max(1, page) - 1) * size,
        take: size,
        include: {
          items: { include: { order_item: { select: { sku_snapshot: true, name_ru_snapshot: true, qty: true } } } },
          media: { select: { id: true }, orderBy: { created_at: 'asc' } },
          order: { select: { id: true, order_number: true, delivered_at: true, total_uzs: true, goods_paid_uzs: true, bonus_used_uzs: true, recipient_name: true, recipient_phone: true, payments: { orderBy: { created_at: 'desc' }, take: 1, select: { method: { select: { code: true } } } } } },
          user: { select: { id: true, first_name: true, last_name: true } },
          staff: { select: { name: true } },
        },
      }),
      this.prisma.returns.groupBy({ by: ['status'], where: { order: { is_test: false } }, _count: { _all: true } }),
    ]);
    const staffIds = [...new Set(rows.flatMap((r) => [r.rejected_by, r.refunded_by]).filter((x): x is string => !!x))];
    const names = new Map((await this.prisma.staff_users.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    return {
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      total,
      items: rows.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        comment: r.comment,
        full_order: r.full_order,
        created_at: r.created_at.toISOString(),
        order: {
          id: r.order.id,
          number: r.order.order_number,
          delivered_at: r.order.delivered_at?.toISOString() ?? null,
          total_uzs: Number(r.order.total_uzs),
          payment: r.order.payments[0]?.method.code ?? null,
          recipient: r.order.recipient_name,
          phone: r.order.recipient_phone,
        },
        customer: { id: r.user.id, name: [r.user.first_name, r.user.last_name].filter(Boolean).join(' ') },
        items: r.items.map((x) => ({ sku: x.order_item.sku_snapshot, name: x.order_item.name_ru_snapshot, qty: x.qty, line_qty: x.order_item.qty, amount_uzs: Number(x.refund_amount_uzs) })),
        suggested_uzs: r.items.reduce((s, x) => s + Number(x.refund_amount_uzs), 0),
        media: r.media.map((m) => m.id),
        refund_amount_uzs: r.refund_amount_uzs == null ? null : Number(r.refund_amount_uzs),
        approved_by: r.staff?.name ?? null,
        approved_at: r.approved_at?.toISOString() ?? null,
        reject_reason: r.reject_reason,
        rejected_by: r.rejected_by ? (names.get(r.rejected_by) ?? null) : null,
        rejected_at: r.rejected_at?.toISOString() ?? null,
        refund_method: r.refund_method,
        refund_comment: r.refund_comment,
        refunded_by: r.refunded_by ? (names.get(r.refunded_by) ?? null) : null,
        refunded_at: r.refunded_at?.toISOString() ?? null,
        bonus_reversed_uzs: Number(r.bonus_reversed_uzs),
        bonus_returned_uzs: Number(r.bonus_returned_uzs),
      })),
    };
  }

  async mediaFile(returnId: string, mediaId: string): Promise<Buffer> {
    const m = await this.prisma.return_media.findFirst({ where: { id: mediaId, return_id: returnId } });
    if (!m) throw new NotFoundException('Photo not found');
    return readFile(this.privatePath(m.url));
  }

  /**
   * «Одобрить»: the amount to give back (the paid price of the jars by default; the staff may change it, at most the
   * order total). The whole order → the order «Возврат» (units on check, all bonuses back); a part → the bonuses of
   * the returned lines by their share. Either way a refund task for the manager; the refund itself is manual.
   */
  async approve(id: string, staffId: string, amount: number) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockReturn(tx, id);
      if (r.status !== 'requested') throw new ConflictException({ code: 'RETURN_STATUS', message: 'Заявка уже рассмотрена' });
      const order = await this.lifecycle.lockOrder(tx, r.order_id);
      const o = await tx.orders.findUniqueOrThrow({ where: { id: order.id }, select: { total_uzs: true, goods_paid_uzs: true, bonus_used_uzs: true, user_id: true } });
      if (!Number.isInteger(amount) || amount < 1 || amount > Number(o.total_uzs)) {
        throw new BadRequestException({ code: 'RETURN_AMOUNT', message: `Сумма от 1 до ${Number(o.total_uzs)} сум` });
      }
      const why = `Возврат по заявке: ${RETURN_REASON_TEXT[r.reason]?.ru ?? r.reason}`;
      let reversed = 0;
      let returned = 0;
      let jars: string[] = [];
      if (r.full_order && order.status === 'delivered') {
        // the existing way of «Возврат» (S2C-5): units wait for the warehouse check; BonusService gives back everything
        jars = await this.units.returnAfterHandover(tx, order, staffId, why);
        await tx.orders.update({ where: { id: order.id }, data: { status: 'return' } });
        await this.lifecycle.addHistory(tx, order.id, 'delivered', 'return', { type: 'staff', id: staffId }, why);
      } else {
        const goods = r.items.reduce((s, x) => s + Number(x.refund_amount_uzs), 0);
        const paidGoods = Number(o.goods_paid_uzs);
        const accrued = await tx.bonus_ledger.findUnique({ where: { idempotency_ref: `purchase:${order.id}` }, select: { amount_uzs: true } });
        const take = bonusShare(Number(accrued?.amount_uzs ?? 0), goods, paidGoods);
        if (take > 0) {
          const t = await this.bonus.post(tx, { userId: o.user_id, op: 'reversal', amount: -take, ref: `unpurchase:return:${r.id}`, orderId: order.id, reason: `Возврат части заказа ${order.order_number}: кешбэк за возвращённые товары` });
          reversed = t ? -t.amount_uzs : 0;
        }
        const back = (await tx.bonus_ledger.findUnique({ where: { idempotency_ref: `redeem:${order.id}` }, select: { id: true } })) ? bonusShare(Number(o.bonus_used_uzs), goods, paidGoods) : 0;
        if (back > 0) {
          const g = await this.bonus.post(tx, { userId: o.user_id, op: 'reversal', amount: back, ref: `refund:return:${r.id}`, orderId: order.id, reason: `Возврат части заказа ${order.order_number}: бонусы возвращены` });
          returned = g?.amount_uzs ?? 0;
        }
      }
      await tx.returns.update({
        where: { id },
        data: { status: 'approved', approved_by: staffId, approved_at: new Date(), refund_amount_uzs: BigInt(amount), bonus_reversed_uzs: BigInt(reversed), bonus_returned_uzs: BigInt(returned) },
      });
      await tx.manager_tasks.create({
        data: {
          type: 'refund',
          order_id: order.id,
          note: `Вернуть клиенту ${amount} сум по заявке на возврат: заказ ${order.order_number}${r.full_order ? ' (весь заказ)' : ' (часть заказа; товар принять через «Склад → Возврат»)'}. Причина: ${RETURN_REASON_TEXT[r.reason]?.ru ?? r.reason}`,
        },
      });
      await this.customerMessage(tx, id, 'return.approved');
      return { id, status: 'approved' as const, full_order: r.full_order, refund_amount_uzs: amount, bonus_reversed_uzs: reversed, bonus_returned_uzs: returned, units: jars };
    }, TX);
  }

  async reject(id: string, staffId: string, reason: string) {
    const text = reason.trim();
    if (!text) throw new BadRequestException({ code: 'RETURN_REJECT_REASON', message: 'Укажите причину' });
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockReturn(tx, id);
      if (r.status !== 'requested') throw new ConflictException({ code: 'RETURN_STATUS', message: 'Заявка уже рассмотрена' });
      await tx.returns.update({ where: { id }, data: { status: 'rejected', reject_reason: text, rejected_by: staffId, rejected_at: new Date() } });
      await this.customerMessage(tx, id, 'return.rejected');
      return { id, status: 'rejected' as const };
    }, TX);
  }

  /** «Деньги возвращены»: how and a comment; the open refund task of the order is closed. */
  async refunded(id: string, staffId: string, method: RefundMethod, comment?: string) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockReturn(tx, id);
      if (r.status !== 'approved') throw new ConflictException({ code: 'RETURN_STATUS', message: 'Сначала одобрите заявку' });
      const now = new Date();
      await tx.returns.update({ where: { id }, data: { status: 'refunded', refunded_by: staffId, refunded_at: now, refund_method: method, refund_comment: comment?.trim() || null } });
      const task = await tx.manager_tasks.findFirst({ where: { order_id: r.order_id, type: 'refund', status: { not: 'done' } }, orderBy: { created_at: 'asc' } });
      if (task) await tx.manager_tasks.update({ where: { id: task.id }, data: { status: 'done', done_at: now } });
      await this.customerMessage(tx, id, 'return.refunded');
      return { id, status: 'refunded' as const };
    }, TX);
  }

  async requestedCount() {
    return this.prisma.returns.count({ where: { status: 'requested', order: { is_test: false } } });
  }

  // ───────────── helpers ─────────────

  private takenQty(returns: { status: ReturnStatus; items: { order_item_id: string; qty: number }[] }[]) {
    const taken = new Map<string, number>();
    for (const r of returns) {
      if (!COUNTED.includes(r.status)) continue;
      for (const i of r.items) taken.set(i.order_item_id, (taken.get(i.order_item_id) ?? 0) + i.qty);
    }
    return taken;
  }

  private blockedError(code: string) {
    const text: Record<string, string> = {
      RETURN_NOT_DELIVERED: 'Вернуть товар можно после получения заказа',
      RETURN_TOO_LATE: `Заявку можно отправить в течение ${RETURN_DAYS} дней после получения`,
      RETURN_ACTIVE: 'По этому заказу уже есть заявка — дождитесь решения',
      RETURN_NOTHING_LEFT: 'Все товары этого заказа уже возвращены',
    };
    return code === 'RETURN_ACTIVE' ? new ConflictException({ code, message: text[code] }) : new UnprocessableEntityException({ code, message: text[code] ?? code });
  }

  private async lockReturn(tx: Tx, id: string) {
    const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM returns WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) throw new NotFoundException({ code: 'RETURN_NOT_FOUND', message: 'Заявка не найдена' });
    return tx.returns.findUniqueOrThrow({ where: { id }, include: { items: true } });
  }

  private async customerMessage(tx: Tx, returnId: string, template: 'return.received' | 'return.approved' | 'return.rejected' | 'return.refunded') {
    const r = await tx.returns.findUniqueOrThrow({ where: { id: returnId }, include: { order: { select: { id: true, order_number: true } }, user: { select: { telegram_user_id: true, language: true } } } });
    const lang = r.user.language === 'uz' ? 'uz' : 'ru';
    await this.notifications.toCustomer(tx, {
      userId: r.user_id,
      chatId: r.user.telegram_user_id,
      template,
      orderId: r.order_id,
      payload: {
        order_number: r.order.order_number,
        lang,
        total_uzs: r.refund_amount_uzs == null ? undefined : Number(r.refund_amount_uzs),
        reason: template === 'return.rejected' ? r.reject_reason : (RETURN_REASON_TEXT[r.reason]?.[lang] ?? r.reason),
        open_path: `/orders/${r.order_id}`,
      },
      dedupKey: `${template}:${returnId}`,
    });
  }

  private privatePath(key: string): string {
    const path = resolve(join(this.dir, key));
    if (!path.startsWith(this.dir)) throw new Error('Invalid return file key');
    return path;
  }

  private async writePrivate(key: string, data: Buffer) {
    const path = this.privatePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
}
