/**
 * Stage 2B: physical units in the database. Numbers come from the Postgres sequence physical_unit_seq (never reset,
 * a number is never reused; a rollback leaves a gap). Every change of a unit writes a physical_unit_events row
 * (append-only, trigger in the migration).
 */
import { PhysicalUnitStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { costQty } from '../purchases/purchase-cost';
import { formatPhysicalId } from './physical-id';
import { lineUnitCosts } from './receiving-math';

type Tx = Prisma.TransactionClient;

/** n new numbers from physical_unit_seq, ascending. */
export async function nextPhysicalNumbers(tx: Tx, n: number): Promise<number[]> {
  if (n <= 0) return [];
  const rows = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('physical_unit_seq') AS n FROM generate_series(1, ${n}::int)`;
  return rows.map((r) => Number(r.n)).sort((a, b) => a - b);
}

export interface NewUnit {
  product_id: string;
  purchase_id: string | null;
  purchase_line_id: string | null;
  cost: bigint;
  expiry: string; // YYYY-MM-DD
}

/** Creates the units (status RECEIVED) of a session with their CREATED events; returns them in number order. */
export async function createUnits(tx: Tx, sessionId: string, units: NewUnit[], staffId: string | null): Promise<{ id: string; physical_id: string }[]> {
  const numbers = await nextPhysicalNumbers(tx, units.length);
  const rows = units.map((u, i) => ({
    id: randomUUID(),
    physical_id: formatPhysicalId(numbers[i]),
    seq: numbers[i],
    product_id: u.product_id,
    purchase_id: u.purchase_id,
    purchase_line_id: u.purchase_line_id,
    receiving_session_id: sessionId,
    actual_cost_uzs: u.cost,
    expiry_date: new Date(`${u.expiry}T00:00:00Z`),
    status: 'RECEIVED' as const,
  }));
  if (!rows.length) return [];
  await tx.physical_units.createMany({ data: rows });
  await tx.physical_unit_events.createMany({
    data: rows.map((r) => ({
      physical_unit_id: r.id,
      type: 'CREATED',
      to_status: 'RECEIVED' as const,
      reference_type: 'receiving_session',
      reference_id: sessionId,
      created_by: staffId,
    })),
  });
  return rows.map((r) => ({ id: r.id, physical_id: r.physical_id }));
}

/** Moves units from one status to another with an event per unit (only those still in `from`). */
export async function moveUnits(
  tx: Tx,
  where: Prisma.physical_unitsWhereInput,
  from: PhysicalUnitStatus,
  to: PhysicalUnitStatus,
  e: { type: string; referenceType?: string; referenceId?: string; note?: string | null; staffId: string | null },
): Promise<{ id: string; product_id: string; purchase_line_id: string | null }[]> {
  const units = await tx.physical_units.findMany({ where: { ...where, status: from }, select: { id: true, product_id: true, purchase_line_id: true }, orderBy: { seq: 'asc' } });
  if (!units.length) return [];
  await tx.physical_units.updateMany({ where: { id: { in: units.map((u) => u.id) }, status: from }, data: { status: to } });
  await tx.physical_unit_events.createMany({
    data: units.map((u) => ({
      physical_unit_id: u.id,
      type: e.type,
      from_status: from,
      to_status: to,
      reference_type: e.referenceType ?? null,
      reference_id: e.referenceId ?? null,
      note: e.note ?? null,
      created_by: e.staffId,
    })),
  });
  return units;
}

/**
 * Costs of the units of a purchase line (not VOIDED, by number) after the allocated total of the line changed or
 * units were voided: the k-th unit gets the k-th share (receiving-math lineUnitCosts). A COST_CHANGED event for
 * each unit whose cost moved.
 */
export async function reassignLineUnitCosts(tx: Tx, lineId: string, staffId: string | null): Promise<void> {
  const line = await tx.purchase_lines.findUnique({ where: { id: lineId } });
  if (!line) return;
  const units = await tx.physical_units.findMany({
    where: { purchase_line_id: lineId, status: { not: 'VOIDED' } },
    orderBy: { seq: 'asc' },
    select: { id: true, actual_cost_uzs: true },
  });
  if (!units.length) return;
  const costs = lineUnitCosts(line.allocated_total_uzs ?? 0n, costQty(line), units.length);
  for (const [k, u] of units.entries()) {
    if (u.actual_cost_uzs === costs[k]) continue;
    await tx.physical_units.update({ where: { id: u.id }, data: { actual_cost_uzs: costs[k] } });
    await tx.physical_unit_events.create({
      data: {
        physical_unit_id: u.id,
        type: 'COST_CHANGED',
        reference_type: 'purchase',
        reference_id: line.purchase_id,
        note: `Себестоимость пересчитана: ${u.actual_cost_uzs} → ${costs[k]} сум`,
        created_by: staffId,
      },
    });
  }
}

/** Units of a line that count (everything except VOIDED). */
export const liveUnitsOfLine = (tx: Tx, lineId: string) => tx.physical_units.count({ where: { purchase_line_id: lineId, status: { not: 'VOIDED' } } });

// ---------------------------------------------------------------- views

export const unitInclude = {
  product: { select: { id: true, sku: true, name_ru: true, unit_tracking: true } },
  purchase: { select: { id: true, source_type: true, ozon_order_number: true, purchase_date: true } },
} satisfies Prisma.physical_unitsInclude;
export type UnitRow = Prisma.physical_unitsGetPayload<{ include: typeof unitInclude }>;

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * A unit for the screens. `full` (purchases.view_costs, admin): its cost and its purchase. Without it no money,
 * no purchase and no Ozon order number — the server leaves them out, the UI only shows what comes.
 */
export function unitView(u: UnitRow, full: boolean) {
  return {
    id: u.id,
    physical_id: u.physical_id,
    product: { id: u.product.id, sku: u.product.sku, name_ru: u.product.name_ru },
    expiry_date: day(u.expiry_date),
    status: u.status,
    receiving_session_id: u.receiving_session_id,
    label_print_count: u.label_print_count,
    last_printed_at: u.last_printed_at,
    created_at: u.created_at,
    ...(full && {
      actual_cost_uzs: Number(u.actual_cost_uzs),
      purchase: u.purchase && {
        id: u.purchase.id,
        source_type: u.purchase.source_type,
        ozon_order_number: u.purchase.ozon_order_number,
        purchase_date: day(u.purchase.purchase_date),
      },
    }),
  };
}

/**
 * What the 58×40 label carries: Physical ID (also in the QR code), SKU and the expiry date. No product name, no
 * composition, no order or purchase numbers, no price or cost (S2B-2).
 */
export function labelView(u: UnitRow) {
  return {
    id: u.id,
    physical_id: u.physical_id,
    sku: u.product.sku,
    expiry_date: day(u.expiry_date),
  };
}
