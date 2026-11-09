import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { StockService } from '../inventory/stock.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  addDays,
  BATCH_MANUAL_STAGES,
  BATCH_STAGES,
  CB_STAGES,
  expectedWindow,
  isoDay,
  isOverdue,
  loadCrossBorderSettings,
  stageIndex,
  type BatchStage,
  type CbStage,
} from './cross-border';
import { crossBorderStageOf } from './order-view';
import { OrderUnitsService } from './order-units.service';

type Tx = Prisma.TransactionClient;
const TX = { maxWait: 10_000, timeout: 30_000 };

const stageInclude = { items: { select: { source: true, arrived_at: true, cross_border_batch: { select: { stage: true } } } } } satisfies Prisma.ordersInclude;

/**
 * D-60, «Под заказ из США»: the parcels, the stages the customer sees, the moved dates and the jars of the lines.
 *
 * - A line from the USA reserves nothing at the order. After the payment it waits to be put into a parcel.
 * - A parcel («Посылка из США») is one order on iHerb for several customers' lines: its stage is set once for all of
 *   them and every customer whose order moved forward gets a message (and an entry in the order's timeline).
 * - When the jars are in Tashkent (the parcel's purchase is received, or staff gives the Tashkent stock to the line)
 *   the line gets them exactly as a paid order would: quantity reserved, unit-tracked jars reserved by FEFO.
 *   Once every line from the USA has its jars the order goes the usual way (picking → courier → delivered).
 */
@Injectable()
export class CrossBorderService {
  private readonly logger = new Logger(CrossBorderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly units: OrderUnitsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Payment confirmed: the promised window is counted from the payment (the order kept the one from its creation). */
  async onPaid(tx: Tx, orderId: string, paidAt: Date): Promise<void> {
    if (!(await tx.order_items.count({ where: { order_id: orderId, source: 'cross_border' } }))) return;
    const w = expectedWindow(paidAt, await loadCrossBorderSettings(tx));
    await tx.orders.update({ where: { id: orderId }, data: { expected_from: w.expected_from, expected_to: w.expected_to } });
  }

  /** «Собирается» only when every line from the USA has its jars in Tashkent. */
  async assertReadyForPicking(tx: Tx, orderId: string): Promise<void> {
    const waiting = await tx.order_items.findMany({ where: { order_id: orderId, source: 'cross_border', arrived_at: null }, select: { sku_snapshot: true } });
    if (waiting.length) {
      throw new ConflictException({ code: 'CROSS_BORDER_WAITING', message: `Ждём товар из США: ${waiting.map((w) => w.sku_snapshot).join(', ')}. Собирать можно, когда банки будут на складе.` });
    }
  }

  /**
   * The order's stage moved forward → one timeline entry and one customer message per stage (never twice, never back).
   * Called after a parcel stage, after jars were attached and after a line was put into a parcel.
   */
  async syncStage(tx: Tx, orderId: string, staffId: string | null, batchId: string | null = null): Promise<CbStage | null> {
    const order = await tx.orders.findUniqueOrThrow({ where: { id: orderId }, include: { ...stageInclude, user: true } });
    const stage = crossBorderStageOf(order);
    if (!stage || stage === 'paid') return stage;
    const done = await tx.cross_border_events.findMany({ where: { order_id: orderId, type: 'stage' }, select: { stage: true } });
    const last = done.reduce((m, e) => Math.max(m, stageIndex(e.stage as CbStage)), 0);
    if (stageIndex(stage) <= last) return stage;
    await tx.cross_border_events.create({ data: { order_id: orderId, batch_id: batchId, type: 'stage', stage, created_by: staffId } });
    const expiry = stage === 'in_stock' ? await this.earliestExpiry(tx, orderId) : null;
    await this.notifications.toCustomer(tx, {
      userId: order.user_id,
      chatId: order.user.telegram_user_id,
      orderId,
      template: 'order.cb_stage',
      payload: {
        order_number: order.order_number,
        lang: order.user.language,
        open_path: `/orders/${orderId}`,
        stage: stage as Exclude<CbStage, 'paid'>,
        expected_from: isoDay(order.expected_from),
        expected_to: isoDay(order.expected_to),
        expiry,
      },
      dedupKey: `order:${orderId}:cb:${stage}`,
    });
    return stage;
  }

  /** The earliest expiry of the jars reserved for the order's lines from the USA (null: not unit-tracked). */
  private async earliestExpiry(tx: Tx, orderId: string): Promise<string | null> {
    const u = await tx.order_item_units.findFirst({
      where: { order_id: orderId, released_at: null, item: { source: 'cross_border' } },
      orderBy: { unit: { expiry_date: 'asc' } },
      include: { unit: { select: { expiry_date: true } } },
    });
    return isoDay(u?.unit.expiry_date);
  }

  /**
   * The jars of one waiting line are in Tashkent: the quantity is reserved (409 INSUFFICIENT_STOCK when there is
   * not enough), unit-tracked jars are reserved by FEFO; other products are written off at once (the order is paid).
   */
  async attachLine(tx: Tx, itemId: string, staffId: string | null): Promise<void> {
    const item = await tx.order_items.findUnique({ where: { id: itemId }, include: { product: { select: { unit_tracking: true } } } });
    if (!item || item.source !== 'cross_border') throw new NotFoundException({ code: 'NOT_CROSS_BORDER', message: 'Это не строка «из США»' });
    if (item.arrived_at) throw new ConflictException({ code: 'ALREADY_ARRIVED', message: 'Банки этой строки уже на складе' });
    const [order] = await tx.$queryRaw<{ id: string; order_number: string; status: string }[]>`
      SELECT id, order_number, status::text AS status FROM orders WHERE id = ${item.order_id}::uuid FOR UPDATE`;
    if (order.status !== 'paid') throw new ConflictException({ code: 'ORDER_NOT_WAITING', message: 'Заказ не ждёт товар (не оплачен или уже отменён)' });
    await this.stock.reserve(tx, order.id, [{ product_id: item.product_id, qty: item.qty }]);
    if (item.product.unit_tracking) await this.units.reserveItem(tx, { id: order.id, order_number: order.order_number, status: 'paid' }, item.id, staffId);
    else await this.stock.deductProducts(tx, order.id, [item.product_id], staffId ?? undefined);
    await tx.order_items.update({ where: { id: item.id }, data: { arrived_at: new Date() } });
    await this.syncStage(tx, order.id, staffId, item.cross_border_batch_id);
  }

  /**
   * After a receiving: the new jars go to the paid lines that wait for them, the earliest payment first. A line that
   * does not fit stops the queue of its product (later lines never jump ahead). Every line in its own savepoint.
   */
  async fulfilWaiting(tx: Tx, productIds: string[], staffId: string | null): Promise<number> {
    let attached = 0;
    for (const productId of [...productIds].sort()) {
      const waiting = await tx.order_items.findMany({
        where: { product_id: productId, source: 'cross_border', arrived_at: null, order: { status: 'paid' } },
        include: { order: { select: { paid_at: true } } },
      });
      waiting.sort((a, b) => (a.order.paid_at?.getTime() ?? 0) - (b.order.paid_at?.getTime() ?? 0) || a.id.localeCompare(b.id));
      for (const line of waiting) {
        const free = (await this.stock.availability([productId], tx)).get(productId) ?? 0;
        if (free < line.qty) break;
        await tx.$executeRawUnsafe('SAVEPOINT cb_attach');
        try {
          await this.attachLine(tx, line.id, staffId);
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT cb_attach');
          attached++;
        } catch (e) {
          if (!(e instanceof ConflictException)) throw e;
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT cb_attach');
          break;
        }
      }
    }
    return attached;
  }

  // ───────────── «Посылки из США» (admin panel) ─────────────

  /** Paid lines from the USA not yet in a parcel, the earliest payment first. */
  async waiting() {
    const rows = await this.prisma.order_items.findMany({
      where: { source: 'cross_border', arrived_at: null, cross_border_batch_id: null, order: { status: 'paid' } },
      include: { order: { select: { id: true, order_number: true, paid_at: true, expected_to: true } }, product: { select: { sku: true, name_ru: true, iherb_url: true } } },
    });
    return rows
      .sort((a, b) => (a.order.paid_at?.getTime() ?? 0) - (b.order.paid_at?.getTime() ?? 0))
      .map((r) => ({
        item_id: r.id,
        order_id: r.order.id,
        order_number: r.order.order_number,
        paid_at: r.order.paid_at,
        expected_to: isoDay(r.order.expected_to),
        product_id: r.product_id,
        sku: r.product.sku,
        name_ru: r.product.name_ru,
        iherb_url: r.product.iherb_url,
        qty: r.qty,
      }));
  }

  async batches() {
    const rows = await this.prisma.cross_border_batches.findMany({
      orderBy: { created_at: 'desc' },
      take: 100,
      include: { items: { select: { qty: true, order_id: true, arrived_at: true } }, purchase: { select: { id: true, purchase_date: true, status: true } } },
    });
    return rows.map((b) => ({
      id: b.id,
      number: b.number,
      stage: b.stage,
      note: b.note,
      ordered_at: b.ordered_at,
      shipped_at: b.shipped_at,
      arrived_uz_at: b.arrived_uz_at,
      received_at: b.received_at,
      purchase: b.purchase && { id: b.purchase.id, purchase_date: isoDay(b.purchase.purchase_date), status: b.purchase.status },
      orders: new Set(b.items.map((i) => i.order_id)).size,
      jars: b.items.reduce((s, i) => s + i.qty, 0),
      jars_arrived: b.items.filter((i) => i.arrived_at).reduce((s, i) => s + i.qty, 0),
    }));
  }

  async batch(id: string) {
    const b = await this.prisma.cross_border_batches.findUnique({
      where: { id },
      include: {
        items: { include: { order: { select: { id: true, order_number: true, status: true, paid_at: true, expected_from: true, expected_to: true } }, product: { select: { sku: true, name_ru: true } } } },
        purchase: { select: { id: true, purchase_date: true, status: true } },
      },
    });
    if (!b) throw new NotFoundException('Parcel not found');
    const [summary] = (await this.batches()).filter((x) => x.id === id);
    return {
      ...(summary ?? {}),
      items: b.items
        .sort((x, y) => x.order.order_number.localeCompare(y.order.order_number))
        .map((i) => ({
          item_id: i.id,
          order_id: i.order.id,
          order_number: i.order.order_number,
          order_status: i.order.status,
          expected_from: isoDay(i.order.expected_from),
          expected_to: isoDay(i.order.expected_to),
          sku: i.product.sku,
          name_ru: i.product.name_ru,
          qty: i.qty,
          arrived_at: i.arrived_at,
        })),
    };
  }

  /** «Создать посылку»: the lines just ordered on iHerb — their customers get «Заказан в США». */
  async createBatch(staffId: string, input: { item_ids: string[]; note?: string | null; purchase_id?: string | null }) {
    if (!input.item_ids.length) throw new ConflictException({ code: 'EMPTY_BATCH', message: 'Отметьте строки заказов для посылки' });
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.cross_border_batches.create({ data: { note: input.note?.trim() || null, purchase_id: input.purchase_id ?? null, created_by: staffId } });
      await this.putLines(tx, batch.id, input.item_ids, staffId);
      await tx.audit_logs.create({ data: { staff_user_id: staffId, action: 'cross_border.batch_created', entity_type: 'cross_border_batch', entity_id: batch.id, after_json: { number: batch.number, item_ids: input.item_ids } } });
      return { id: batch.id, number: batch.number };
    }, TX);
  }

  /** «Добавить в посылку»: more lines into a parcel that is not received yet. */
  async addToBatch(staffId: string, batchId: string, itemIds: string[]) {
    await this.prisma.$transaction(async (tx) => {
      const batch = await tx.cross_border_batches.findUnique({ where: { id: batchId } });
      if (!batch) throw new NotFoundException('Parcel not found');
      if (batch.stage === 'received') throw new ConflictException({ code: 'BATCH_RECEIVED', message: 'Посылка уже принята' });
      await this.putLines(tx, batchId, itemIds, staffId);
      await tx.audit_logs.create({ data: { staff_user_id: staffId, action: 'cross_border.batch_items_added', entity_type: 'cross_border_batch', entity_id: batchId, after_json: { item_ids: itemIds } } });
    }, TX);
    return this.batch(batchId);
  }

  private async putLines(tx: Tx, batchId: string, itemIds: string[], staffId: string) {
    const items = await tx.order_items.findMany({ where: { id: { in: itemIds } }, include: { order: { select: { status: true, order_number: true } } } });
    const bad = items.filter((i) => i.source !== 'cross_border' || i.arrived_at || i.cross_border_batch_id || i.order.status !== 'paid');
    if (items.length !== new Set(itemIds).size || bad.length) {
      throw new ConflictException({ code: 'LINES_NOT_WAITING', message: `Не все строки ждут заказа в США: ${bad.map((b) => b.order.order_number).join(', ') || 'строка не найдена'}` });
    }
    await tx.order_items.updateMany({ where: { id: { in: itemIds } }, data: { cross_border_batch_id: batchId } });
    for (const orderId of new Set(items.map((i) => i.order_id))) await this.syncStage(tx, orderId, staffId, batchId);
  }

  /** «Отправлена из США» / «Прибыла в Узбекистан»: only forward; every customer of the parcel is told once. */
  async setBatchStage(staffId: string, batchId: string, stage: (typeof BATCH_MANUAL_STAGES)[number]) {
    await this.prisma.$transaction(async (tx) => {
      const [batch] = await tx.$queryRaw<{ id: string; stage: string }[]>`SELECT id, stage FROM cross_border_batches WHERE id = ${batchId}::uuid FOR UPDATE`;
      if (!batch) throw new NotFoundException('Parcel not found');
      if (BATCH_STAGES.indexOf(stage) <= BATCH_STAGES.indexOf(batch.stage as BatchStage)) {
        throw new ConflictException({ code: 'STAGE_NOT_FORWARD', message: 'Этап посылки можно только продвинуть вперёд' });
      }
      const now = new Date();
      await tx.cross_border_batches.update({
        where: { id: batchId },
        data: { stage, ...(stage === 'shipped' ? { shipped_at: now } : { arrived_uz_at: now, shipped_at: undefined }) },
      });
      if (stage === 'arrived_uz') await tx.cross_border_batches.updateMany({ where: { id: batchId, shipped_at: null }, data: { shipped_at: now } });
      const orders = await tx.order_items.findMany({ where: { cross_border_batch_id: batchId }, select: { order_id: true }, distinct: ['order_id'] });
      for (const o of orders) await this.syncStage(tx, o.order_id, staffId, batchId);
      await tx.audit_logs.create({ data: { staff_user_id: staffId, action: 'cross_border.batch_stage', entity_type: 'cross_border_batch', entity_id: batchId, before_json: { stage: batch.stage }, after_json: { stage } } });
    }, TX);
    return this.batch(batchId);
  }

  /** The purchase the parcel is received by (its receiving attaches the jars to the waiting lines). */
  async setBatchPurchase(staffId: string, batchId: string, purchaseId: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.cross_border_batches.findUnique({ where: { id: batchId } });
      if (!before) throw new NotFoundException('Parcel not found');
      if (purchaseId && !(await tx.purchases.findUnique({ where: { id: purchaseId } }))) throw new NotFoundException('Purchase not found');
      await tx.cross_border_batches.update({ where: { id: batchId }, data: { purchase_id: purchaseId } });
      await tx.audit_logs.create({ data: { staff_user_id: staffId, action: 'cross_border.batch_purchase', entity_type: 'cross_border_batch', entity_id: batchId, before_json: { purchase_id: before.purchase_id }, after_json: { purchase_id: purchaseId } } });
    }, TX);
    return this.batch(batchId);
  }

  /** «Отдать банки со склада»: the Tashkent stock is given to a waiting line before its parcel comes. */
  async attachFromStock(staffId: string, itemId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.attachLine(tx, itemId, staffId);
      await this.markReceivedBatches(tx);
      await tx.audit_logs.create({ data: { staff_user_id: staffId, action: 'cross_border.attached_from_stock', entity_type: 'order_item', entity_id: itemId } });
    }, TX);
  }

  /** A parcel whose every line got its jars is «Принята на складе». */
  async markReceivedBatches(tx: Tx): Promise<void> {
    await tx.$executeRaw`
      UPDATE cross_border_batches b SET stage = 'received', received_at = now(), updated_at = now()
      WHERE b.stage <> 'received'
        AND EXISTS (SELECT 1 FROM order_items i WHERE i.cross_border_batch_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id
                        WHERE i.cross_border_batch_id = b.id AND i.arrived_at IS NULL AND o.status = 'paid')`;
  }

  /**
   * «Сдвинуть дату»: a new last day (and the reason the customer reads) for the orders of a parcel or one order.
   * Only orders still waiting for the USA; the first day never goes past the last one.
   */
  async moveDate(staffId: string, input: { batch_id?: string; order_id?: string; expected_to: string; reason: string }) {
    const to = new Date(`${input.expected_to}T00:00:00.000Z`);
    if (Number.isNaN(to.getTime())) throw new ConflictException({ code: 'BAD_DATE', message: 'Неверная дата' });
    if (to.getTime() < addDays(new Date(), 0).getTime()) throw new ConflictException({ code: 'DATE_IN_PAST', message: 'Новая дата не может быть в прошлом' });
    const reason = input.reason.trim();
    if (!reason) throw new ConflictException({ code: 'REASON_REQUIRED', message: 'Напишите причину — её прочитает покупатель' });
    let moved = 0;
    await this.prisma.$transaction(async (tx) => {
      const orderIds = input.order_id
        ? [input.order_id]
        : (await tx.order_items.findMany({ where: { cross_border_batch_id: input.batch_id }, select: { order_id: true }, distinct: ['order_id'] })).map((o) => o.order_id);
      for (const orderId of orderIds) {
        const order = await tx.orders.findUnique({ where: { id: orderId }, include: { ...stageInclude, user: true } });
        if (!order) continue;
        const stage = crossBorderStageOf(order);
        if (order.status !== 'paid' || !stage || stage === 'in_stock') continue;
        // after a delay the customer gets one new day («до 30 ноября»), not a range that starts before the old end
        const from = to;
        await tx.orders.update({ where: { id: orderId }, data: { expected_from: from, expected_to: to } });
        await tx.cross_border_events.create({ data: { order_id: orderId, batch_id: input.batch_id ?? null, type: 'delay', expected_from: from, expected_to: to, reason, created_by: staffId } });
        await this.notifications.toCustomer(tx, {
          userId: order.user_id,
          chatId: order.user.telegram_user_id,
          orderId,
          template: 'order.cb_delay',
          payload: { order_number: order.order_number, lang: order.user.language, open_path: `/orders/${orderId}`, expected_from: isoDay(from), expected_to: isoDay(to), reason },
        });
        moved++;
      }
      await tx.audit_logs.create({ data: { staff_user_id: staffId, action: 'cross_border.date_moved', entity_type: input.batch_id ? 'cross_border_batch' : 'order', entity_id: input.batch_id ?? input.order_id ?? null, after_json: { expected_to: input.expected_to, reason, orders: moved } } });
    }, TX);
    return { moved };
  }

  /** Every hour: the promised last day passed and the jars are still not in Tashkent → admins and managers, once per date. */
  @Interval('cross-border-overdue', 60 * 60_000)
  async overdueJob(): Promise<void> {
    if (process.env.JOBS_ENABLED === 'false') return;
    try {
      await this.remindOverdue();
    } catch (e) {
      this.logger.error('Cross-border overdue reminder failed', e as Error);
    }
  }

  async remindOverdue(now = new Date()): Promise<number> {
    const orders = await this.prisma.orders.findMany({
      where: { status: 'paid', expected_to: { lt: addDays(now, 0) }, items: { some: { source: 'cross_border', arrived_at: null } } },
      include: stageInclude,
    });
    let sent = 0;
    for (const o of orders) {
      if (!isOverdue({ status: o.status, stage: crossBorderStageOf(o), expected_to: o.expected_to, overdue_for: o.cross_border_overdue_for }, now)) continue;
      await this.prisma.$transaction(async (tx) => {
        await tx.orders.update({ where: { id: o.id }, data: { cross_border_overdue_for: o.expected_to } });
        await this.notifications.toStaffRoles(tx, ['admin', 'manager'], 'staff.cb_overdue', { order_number: o.order_number, expected_to: isoDay(o.expected_to), admin_path: `/orders/${o.id}` });
      });
      sent++;
    }
    return sent;
  }

  /** The stages in the order they go (for the admin panel). */
  stages() {
    return CB_STAGES;
  }
}
