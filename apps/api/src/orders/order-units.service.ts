import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, PhysicalUnitStatus, Prisma } from '@prisma/client';
import { StockService } from '../inventory/stock.service';
import { earlierThan, moveUnit, oldestFreeUnit, takeFefoUnits, UNIT_STATUS_RU } from '../marketplace/unit-lifecycle';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { normalizePhysicalId } from '../receiving/physical-id';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

interface OrderRef {
  id: string;
  order_number: string;
  status: OrderStatus;
}

const REF = 'order';
const day = (d: Date) => d.toISOString().slice(0, 10);
const ruDate = (d: Date) => `${day(d).slice(8, 10)}.${day(d).slice(5, 7)}.${day(d).slice(0, 4)}`;

/**
 * Stage 2E: physical units of Mini App (VITALO) orders — the same model as the Yandex orders of 2C, reusing its
 * unit life cycle and FEFO helpers (marketplace/unit-lifecycle.ts).
 *
 * Only unit-tracked products; other lines work by quantity exactly as before.
 * - Payment confirmed: the quantity reservation of the order STAYS (no write-off at payment any more for these
 *   lines) and concrete units are reserved by FEFO, all or nothing. Not enough units → the order is still paid,
 *   orders.units_attention gets the reason («Нужно внимание склада»), admins and managers get a message.
 * - Assembly: every unit confirmed by its Physical ID; another free unit of the product may replace a reserved
 *   one (soft FEFO: a reason when it is not the earliest expiry).
 * - Handed to delivery: units «В доставке (VITALO)», the cost snapshot is taken, the held quantity is written off
 *   (the only write-off). Delivered: «Продана (VITALO)».
 * - Cancel before the handover: units back «На складе» (the caller releases the quantity). After it: «Возврат на
 *   проверке», decided per unit on the warehouse screen (2C).
 *
 * «Legacy» paid orders from before 2E (written off at payment, no units) are recognised by «holds nothing» and
 * keep working the old way.
 */
@Injectable()
export class OrderUnitsService {
  constructor(
    private readonly stock: StockService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Lines of unit-tracked products with what the order still holds of each product. */
  private async trackedLines(tx: Tx, orderId: string) {
    const items = await tx.order_items.findMany({ where: { order_id: orderId, product: { unit_tracking: true } }, include: { product: { select: { sku: true } } }, orderBy: { id: 'asc' } });
    const held = await this.stock.heldByProduct(tx, orderId);
    return items.map((i) => ({ ...i, held: held.get(i.product_id) ?? 0 }));
  }

  /** Products whose write-off must wait for the handover (called by the payment confirmation). */
  async trackedProductIds(tx: Tx, orderId: string): Promise<string[]> {
    const items = await tx.order_items.findMany({ where: { order_id: orderId, product: { unit_tracking: true } }, select: { product_id: true } });
    return [...new Set(items.map((i) => i.product_id))];
  }

  /**
   * Payment confirmed: FEFO units for every unit-tracked line, all or nothing (savepoint). A shortage never fails
   * the payment: the order gets units_attention and the staff a message. Repeating it reserves nothing twice.
   */
  async reserveOnPayment(tx: Tx, order: OrderRef, staffId: string | null): Promise<{ reserved: string[]; shortage: string | null }> {
    if (await tx.order_item_units.count({ where: { order_id: order.id, released_at: null } })) return { reserved: [], shortage: null };
    const lines = await this.trackedLines(tx, order.id);
    if (!lines.length) return { reserved: [], shortage: null };
    await tx.$executeRawUnsafe('SAVEPOINT order_units');
    try {
      const reserved = await this.reserveAll(tx, order, lines, staffId);
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT order_units');
      return { reserved, shortage: null };
    } catch (e) {
      if (!(e instanceof ConflictException)) throw e;
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT order_units');
      const shortage = (e.getResponse() as { message?: string }).message ?? 'не хватает банок';
      await tx.orders.update({ where: { id: order.id }, data: { units_attention: shortage } });
      await this.notifications.toStaffRoles(tx, ['admin', 'manager'], 'staff.order_units_attention', { order_number: order.order_number, reason: shortage, admin_path: `/orders/${order.id}` });
      return { reserved: [], shortage };
    }
  }

  /** «Зарезервировать банки» for an order in «Нужно внимание склада»: all or nothing, 409 when still not enough. */
  async reserveMissing(tx: Tx, order: OrderRef, staffId: string | null): Promise<string[]> {
    this.assertBeforeHandover(order, 'резервировать банки');
    if (await tx.order_item_units.count({ where: { order_id: order.id, released_at: null } })) {
      throw new ConflictException({ code: 'ALREADY_RESERVED', message: 'Банки этого заказа уже зарезервированы' });
    }
    const lines = await this.trackedLines(tx, order.id);
    const reserved = await this.reserveAll(tx, order, lines, staffId);
    await tx.orders.update({ where: { id: order.id }, data: { units_attention: null } });
    return reserved;
  }

  /**
   * D-60: the jars of one line «из США» came (the parcel was received or the Tashkent stock is given to it): FEFO
   * units for this line only, all or nothing (409 NOT_ENOUGH_UNITS). The caller reserved the quantity first.
   */
  async reserveItem(tx: Tx, order: OrderRef, itemId: string, staffId: string | null): Promise<string[]> {
    const lines = (await this.trackedLines(tx, order.id)).filter((l) => l.id === itemId);
    return this.reserveAll(tx, order, lines, staffId);
  }

  private async reserveAll(tx: Tx, order: OrderRef, lines: Awaited<ReturnType<OrderUnitsService['trackedLines']>>, staffId: string | null): Promise<string[]> {
    const reserved: string[] = [];
    // products in a fixed order: two payments with the same products cannot deadlock
    for (const line of [...lines].sort((a, b) => a.product_id.localeCompare(b.product_id) || a.id.localeCompare(b.id))) {
      if (line.held <= 0) continue; // a legacy order (written off at payment before 2E): nothing to reserve
      const units = await takeFefoUnits(tx, line.product_id, line.qty);
      if (units.length < line.qty) {
        throw new ConflictException({ code: 'NOT_ENOUGH_UNITS', message: `${line.product.sku}: нужно банок: ${line.qty}, свободных на складе: ${units.length}` });
      }
      for (const u of units) {
        await this.assign(tx, order, line.id, u.id, staffId, null, false);
        reserved.push(u.physical_id);
      }
    }
    return reserved;
  }

  /**
   * Assembly: the Physical ID typed or scanned. A reserved unit of the order → confirmed. Another free unit of a
   * product of the order replaces a reserved, not yet confirmed one (that goes back «На складе»; the quantity
   * reservation does not change). Not the earliest expiry → 409 FEFO_REASON_REQUIRED until a reason is given.
   */
  async pick(tx: Tx, order: OrderRef, physicalIdRaw: string, fefoReason: string | null, staffId: string): Promise<string> {
    const physicalId = normalizePhysicalId(physicalIdRaw);
    if (!physicalId) throw new BadRequestException({ code: 'BAD_PHYSICAL_ID', message: 'Это не Physical ID: введите, например, V-000184 или 184' });
    this.assertBeforeHandover(order, 'собирать');
    const full = await tx.orders.findUniqueOrThrow({ where: { id: order.id }, select: { units_attention: true } });
    if (full.units_attention) throw new ConflictException({ code: 'RESERVE_FIRST', message: 'У заказа нет банок (не хватало на складе): сначала «Зарезервировать банки»' });

    const [unit] = await tx.$queryRaw<{ id: string; physical_id: string; product_id: string; status: PhysicalUnitStatus; expiry_date: Date }[]>`
      SELECT id, physical_id, product_id, status, expiry_date FROM physical_units WHERE physical_id = ${physicalId} FOR UPDATE`;
    if (!unit) throw new NotFoundException({ code: 'UNIT_NOT_FOUND', message: `Банка ${physicalId} не найдена` });
    const active = await tx.order_item_units.findMany({ where: { order_id: order.id, released_at: null }, include: { unit: { select: { physical_id: true, expiry_date: true, product_id: true } } } });

    const own = active.find((a) => a.physical_unit_id === unit.id);
    if (own) {
      if (own.picked_at) return `${physicalId} уже отмечена в этом заказе`;
      await tx.order_item_units.update({ where: { id: own.id }, data: { picked_at: new Date() } });
      await tx.physical_unit_events.create({ data: { physical_unit_id: unit.id, type: 'PICKED', reference_type: REF, reference_id: order.id, note: `Заказ VITALO ${order.order_number}`, created_by: staffId } });
      await this.audit(tx, staffId, 'order.unit_picked', order.id, { physical_id: physicalId });
      return `${physicalId} собрана`;
    }

    if (await tx.order_item_units.findFirst({ where: { physical_unit_id: unit.id, released_at: null } })) {
      throw new ConflictException({ code: 'UNIT_TAKEN', message: `${physicalId} уже в другом заказе VITALO` });
    }
    const yandex = await tx.marketplace_order_units.findFirst({ where: { physical_unit_id: unit.id, released_at: null }, include: { order: { select: { external_number: true } } } });
    if (yandex) throw new ConflictException({ code: 'UNIT_TAKEN', message: `${physicalId} уже в заказе Яндекса №${yandex.order.external_number}` });
    const items = await tx.order_items.findMany({ where: { order_id: order.id }, select: { product_id: true, sku_snapshot: true } });
    if (!items.some((i) => i.product_id === unit.product_id)) {
      const p = await tx.products.findUnique({ where: { id: unit.product_id }, select: { sku: true } });
      throw new ConflictException({ code: 'WRONG_PRODUCT', message: `${physicalId} — это ${p?.sku}, такого товара в заказе нет (${[...new Set(items.map((i) => i.sku_snapshot))].join(', ')})` });
    }
    if (unit.status !== 'IN_STOCK') {
      throw new ConflictException({ code: 'UNIT_NOT_AVAILABLE', message: `${physicalId}: статус «${UNIT_STATUS_RU[unit.status]}», в заказ можно взять только банку «На складе»` });
    }
    // the reserved, not yet confirmed unit the typed one replaces: the latest expiry first, so the rest stay the oldest
    const replaceable = active.filter((a) => !a.picked_at && a.unit.product_id === unit.product_id).sort((a, b) => b.unit.expiry_date.getTime() - a.unit.expiry_date.getTime());
    if (!replaceable.length) throw new ConflictException({ code: 'LINE_COMPLETE', message: 'Все банки этого товара в заказе уже собраны' });

    const free = await oldestFreeUnit(tx, unit.product_id, unit.id);
    const oldest = earlierThan(unit.expiry_date, [...replaceable.map((a) => ({ physical_id: a.unit.physical_id, expiry_date: a.unit.expiry_date })), ...(free ? [free] : [])]);
    if (oldest && !fefoReason) {
      throw new ConflictException({
        code: 'FEFO_REASON_REQUIRED',
        message: `Есть банка со сроком раньше: рекомендуем ${oldest.physical_id}, срок ${ruDate(oldest.expiry_date)}. Чтобы взять ${physicalId} (срок ${ruDate(unit.expiry_date)}), укажите причину.`,
        recommended: { physical_id: oldest.physical_id, expiry_date: day(oldest.expiry_date) },
      });
    }
    const out = replaceable[0];
    await tx.order_item_units.update({ where: { id: out.id }, data: { released_at: new Date(), release_reason: `Заменена при сборке на ${physicalId}` } });
    await moveUnit(tx, out.physical_unit_id, 'ASSIGNED', 'IN_STOCK', { type: 'RELEASED', note: `Заменена при сборке на ${physicalId} (заказ VITALO ${order.order_number})`, referenceType: REF, referenceId: order.id, staffId });
    await this.assign(tx, order, out.order_item_id, unit.id, staffId, oldest ? fefoReason : null, true);
    await this.audit(tx, staffId, 'order.unit_replaced', order.id, { from: out.unit.physical_id, to: physicalId, fefo_reason: oldest ? fefoReason : null });
    return `${physicalId} собрана вместо ${out.unit.physical_id}${oldest ? ' (не самый ранний срок, причина записана)' : ''}`;
  }

  /**
   * Picking → Handed to delivery: every unit-tracked line fully reserved and confirmed; the units leave the shelf
   * (status, cost snapshot) and the held quantity is written off — once, here, never at payment.
   */
  async handOver(tx: Tx, order: OrderRef, staffId: string): Promise<void> {
    const lines = (await this.trackedLines(tx, order.id)).filter((l) => l.held > 0); // legacy lines already left stock at payment
    if (!lines.length) return;
    const full = await tx.orders.findUniqueOrThrow({ where: { id: order.id }, select: { units_attention: true } });
    if (full.units_attention) throw new ConflictException({ code: 'UNITS_ATTENTION', message: `Банки не закреплены: ${full.units_attention}. Сначала «Зарезервировать банки»` });
    const active = await tx.order_item_units.findMany({ where: { order_id: order.id, released_at: null }, include: { unit: { select: { actual_cost_uzs: true } } } });
    const missing = lines.filter((l) => {
      const mine = active.filter((a) => a.order_item_id === l.id);
      return mine.length !== l.qty || mine.some((a) => !a.picked_at);
    });
    if (missing.length) {
      throw new ConflictException({
        code: 'NOT_ALL_PICKED',
        message: `Не все банки отмечены: ${missing.map((l) => `${l.product.sku} ${active.filter((a) => a.order_item_id === l.id && a.picked_at).length} из ${l.qty}`).join(', ')}`,
      });
    }
    for (const a of active) {
      await tx.order_item_units.update({ where: { id: a.id }, data: { cost_snapshot_uzs: a.unit.actual_cost_uzs } });
      await moveUnit(tx, a.physical_unit_id, 'ASSIGNED', 'VITALO_DELIVERY', { type: 'HANDED_TO_DELIVERY', note: `Заказ VITALO ${order.order_number}`, referenceType: REF, referenceId: order.id, staffId });
    }
    await this.stock.deductProducts(tx, order.id, [...new Set(lines.map((l) => l.product_id))], staffId);
  }

  /** Delivered: the units are sold. */
  async deliver(tx: Tx, order: OrderRef, staffId: string): Promise<void> {
    for (const a of await this.activeUnits(tx, order.id)) {
      if (a.unit.status === 'VITALO_DELIVERY') {
        await moveUnit(tx, a.physical_unit_id, 'VITALO_DELIVERY', 'VITALO_SOLD', { type: 'SOLD', note: `Заказ VITALO ${order.order_number}`, referenceType: REF, referenceId: order.id, staffId });
      }
    }
  }

  /** Cancel before the handover: reserved units back «На складе» (the caller releases the quantity). */
  async releaseOnCancel(tx: Tx, order: OrderRef, staffId: string | null, reason: string): Promise<string[]> {
    const released: string[] = [];
    for (const a of await this.activeUnits(tx, order.id)) {
      if (a.unit.status !== 'ASSIGNED') continue;
      await tx.order_item_units.update({ where: { id: a.id }, data: { released_at: new Date(), release_reason: `Отмена заказа: ${reason}` } });
      await moveUnit(tx, a.physical_unit_id, 'ASSIGNED', 'IN_STOCK', { type: 'RELEASED', note: `Отмена заказа VITALO ${order.order_number}: ${reason}`, referenceType: REF, referenceId: order.id, staffId });
      released.push(a.unit.physical_id);
    }
    await tx.orders.update({ where: { id: order.id }, data: { units_attention: null } });
    return released;
  }

  /** Return after the handover: the units wait for a check («Возврат на проверке»), decided per unit (2C). */
  async returnAfterHandover(tx: Tx, order: OrderRef, staffId: string, reason: string): Promise<string[]> {
    const returned: string[] = [];
    for (const a of await this.activeUnits(tx, order.id)) {
      if (a.unit.status !== 'VITALO_DELIVERY' && a.unit.status !== 'VITALO_SOLD') continue;
      await moveUnit(tx, a.physical_unit_id, a.unit.status, 'RETURNED', { type: 'RETURNED', note: `Заказ VITALO ${order.order_number}: ${reason}`, referenceType: REF, referenceId: order.id, staffId });
      returned.push(a.unit.physical_id);
    }
    return returned;
  }

  /**
   * The «Сборка» block of the order card. `money` (costs.view, admin): unit costs and the profit of unit-tracked
   * lines = paid price − cost of the very units (snapshot at the handover, the current cost before it). No logistics.
   */
  async view(db: Db, orderId: string, money: boolean) {
    const order = await db.orders.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, units_attention: true } });
    const items = await db.order_items.findMany({
      where: { order_id: orderId, product: { unit_tracking: true } },
      include: { units: { orderBy: { assigned_at: 'asc' }, include: { unit: { select: { id: true, physical_id: true, expiry_date: true, status: true, actual_cost_uzs: true } } } } },
      orderBy: { id: 'asc' },
    });
    if (!items.length) return null;
    const assembling = order.status === 'paid' || order.status === 'picking';
    const lines = items.map((i) => {
      const active = i.units.filter((u) => !u.released_at);
      const waiting = active.filter((u) => !u.picked_at).sort((a, b) => a.unit.expiry_date.getTime() - b.unit.expiry_date.getTime());
      const cost = active.reduce((s, u) => s + Number(u.cost_snapshot_uzs ?? u.unit.actual_cost_uzs), 0);
      return {
        order_item_id: i.id,
        sku: i.sku_snapshot,
        name: i.name_ru_snapshot,
        qty: i.qty,
        picked: active.filter((u) => u.picked_at).length,
        units: active.map((u) => ({
          unit_id: u.unit.id,
          physical_id: u.unit.physical_id,
          expiry_date: day(u.unit.expiry_date),
          status: u.unit.status,
          picked: !!u.picked_at,
          fefo_override: u.fefo_override,
          ...(money && { cost_uzs: Number(u.cost_snapshot_uzs ?? u.unit.actual_cost_uzs) }),
        })),
        recommended: assembling && waiting[0] ? { physical_id: waiting[0].unit.physical_id, expiry_date: day(waiting[0].unit.expiry_date) } : null,
        released: i.units.filter((u) => u.released_at).map((u) => ({ physical_id: u.unit.physical_id, status: u.unit.status, reason: u.release_reason, return_decision: u.return_decision })),
        ...(money && active.length === i.qty && { money: { paid_uzs: Number(i.paid_line_total_uzs), cost_uzs: cost, profit_uzs: Number(i.paid_line_total_uzs) - cost } }),
      };
    });
    return {
      attention: order.units_attention,
      assembling,
      all_picked: lines.every((l) => l.units.length === l.qty && l.picked === l.qty),
      // a paid order of a unit-tracked product without units and without «внимание»: written off at payment before 2E
      legacy: !order.units_attention && lines.every((l) => !l.units.length && !l.released.length) && !['new', 'awaiting_payment', 'cancelled'].includes(order.status),
      lines,
    };
  }

  // ---------------------------------------------------------------- helpers

  private assertBeforeHandover(order: OrderRef, what: string) {
    if (order.status !== 'paid' && order.status !== 'picking') {
      throw new ConflictException({ code: 'INVALID_STATUS_TRANSITION', message: `Заказ в статусе «${order.status}»: ${what} можно только после оплаты и до передачи в доставку` });
    }
  }

  private activeUnits(tx: Tx, orderId: string) {
    return tx.order_item_units.findMany({ where: { order_id: orderId, released_at: null }, orderBy: { assigned_at: 'asc' }, include: { unit: { select: { physical_id: true, status: true } } } });
  }

  private async assign(tx: Tx, order: OrderRef, itemId: string, unitId: string, staffId: string | null, fefoReason: string | null, picked: boolean) {
    try {
      await tx.order_item_units.create({ data: { order_id: order.id, order_item_id: itemId, physical_unit_id: unitId, assigned_by: staffId, fefo_override: fefoReason, picked_at: picked ? new Date() : null } });
    } catch (e) {
      // «one active order per unit» (index) or «already in a Yandex order» (trigger)
      if (e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Prisma.PrismaClientUnknownRequestError) {
        throw new ConflictException({ code: 'UNIT_TAKEN', message: 'Эта банка только что ушла в другой заказ — повторите' });
      }
      throw e;
    }
    await moveUnit(tx, unitId, 'IN_STOCK', 'ASSIGNED', {
      type: picked ? 'PICKED' : 'ASSIGNED',
      note: `Заказ VITALO ${order.order_number}${fefoReason ? ` · не самый ранний срок: ${fefoReason}` : ''}`,
      referenceType: REF,
      referenceId: order.id,
      staffId,
    });
  }

  private audit(tx: Tx, staffId: string | null, action: string, orderId: string, after: object) {
    return tx.audit_logs.create({ data: { staff_user_id: staffId, action, entity_type: 'order', entity_id: orderId, after_json: after as Prisma.InputJsonObject } });
  }
}
