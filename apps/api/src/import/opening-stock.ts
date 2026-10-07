/**
 * Stage 2B.3: the opening balance in units, from the stock count sheet «Начальные остатки (банки)»
 * (columns found by their headers: «SKU», «Срок годности», «Количество банок»; one row per SKU and expiry date).
 *
 * - The sheet is the truth: every jar on it gets a Physical ID. Jars that already have one (IN_STOCK units from a
 *   completed purchase receiving) are counted in, so only the missing ones are created.
 * - Unit cost = products.cost_uzs (empty -> error). Expiry: ДД.ММ.ГГГГ or an Excel date; required, not in the past.
 * - reserved_qty above the number of jars on the sheet -> error for that SKU. All or nothing: any error -> nothing
 *   is written. A unit-tracked product, or one already in the open opening session, is skipped with a warning,
 *   so running the same file again creates nothing new.
 * - Writes ONE open OPENING_BALANCE session with units in status RECEIVED. Printing labels and «Завершить» happen in
 *   the admin panel (Приёмка → Незавершённые, admin): only then the stock becomes the number of units (an adjustment)
 *   and the product becomes unit-tracked.
 * Plan = read only. Apply = one database transaction.
 */
import ExcelJS from 'exceljs';
import { tashkentDateString } from '../common/tashkent';
import { PrismaService } from '../prisma/prisma.service';
import { checkExpiryGroups, ExpiryGroup, parseDay, ruDay, unitExpiries } from '../receiving/receiving-math';
import { createUnits } from '../receiving/units';
import { auditJson, AuditService } from '../staff/audit.service';

export const OPENING_SHEET = 'Начальные остатки (банки)';
const HEADERS = { sku: 'sku', expiry: 'срок годности', qty: 'количество банок' } as const;
type Col = keyof typeof HEADERS;

export interface OpeningIssue {
  row: number;
  sku?: string;
  message: string;
}

export interface OpeningRowPlan {
  sku: string;
  productId: string;
  name: string;
  actual: number;
  reserved: number;
  /** jars on the sheet */
  sheetQty: number;
  /** sheet − actual_qty: what «Завершить» will change in the stock */
  difference: number;
  cost: number | null;
  groups: ExpiryGroup[];
  /** jars that already have a Physical ID (IN_STOCK) */
  existingUnits: number;
  /** what will be created now (groups minus the existing units) */
  newGroups: ExpiryGroup[];
  newUnits: number;
  action: 'create' | 'skip' | 'error';
  note?: string;
}

export interface OpeningPlan {
  file: string;
  rows: OpeningRowPlan[];
  errors: OpeningIssue[];
  warnings: OpeningIssue[];
}

export interface OpeningResult {
  sessionId: string | null;
  created: { sku: string; units: number; first: string; last: string }[];
}

const headerKey = (s: string) => s.replace(/\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((r) => r.text).join('').trim();
  if (typeof v === 'object' && 'result' in v) return cellText(v.result as ExcelJS.CellValue);
  if (typeof v === 'object' && 'text' in v) return cellText(v.text as ExcelJS.CellValue);
  return String(v).trim();
}

/** An Excel date cell (Date or serial number) or text ДД.ММ.ГГГГ -> YYYY-MM-DD; null when it is not a date. */
export function cellDay(v: ExcelJS.CellValue): string | null {
  if (typeof v === 'object' && v !== null && 'result' in v) return cellDay(v.result as ExcelJS.CellValue);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 20_000 || v > 80_000) return null; // Excel serial days (1954…2119)
    return new Date(Math.round((v - 25_569) * 86_400_000)).toISOString().slice(0, 10);
  }
  return parseDay(cellText(v));
}

function cellInt(v: ExcelJS.CellValue): number | null | 'bad' {
  if (typeof v === 'object' && v !== null && 'result' in v) return cellInt(v.result as ExcelJS.CellValue);
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : 'bad';
  const t = cellText(v).replace(/\s/g, '');
  if (!t) return null;
  return /^\d+$/.test(t) && Number(t) > 0 ? Number(t) : 'bad';
}

// ---------------------------------------------------------------- planning (read only)

export async function planOpeningStock(prisma: PrismaService, file: string, today = tashkentDateString(new Date())): Promise<OpeningPlan> {
  const plan: OpeningPlan = { file, rows: [], errors: [], warnings: [] };
  const error = (row: number, message: string, sku?: string) => plan.errors.push({ row, sku, message });
  const warn = (row: number, message: string, sku?: string) => plan.warnings.push({ row, sku, message });

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(file);
  } catch (e) {
    error(0, `не удалось открыть файл: ${(e as Error).message}`);
    return plan;
  }
  const ws = wb.worksheets.find((w) => headerKey(w.name) === headerKey(OPENING_SHEET));
  if (!ws) {
    error(0, `в файле нет листа «${OPENING_SHEET}» (есть: ${wb.worksheets.map((w) => `«${w.name}»`).join(', ')})`);
    return plan;
  }

  // Header row: the first of the top 10 rows that has all three headers.
  let headerRow = 0;
  const cols: Partial<Record<Col, number>> = {};
  for (let r = 1; r <= Math.min(10, ws.rowCount) && !headerRow; r++) {
    const found: Partial<Record<Col, number>> = {};
    ws.getRow(r).eachCell((cell, c) => {
      const h = headerKey(cellText(cell.value));
      for (const [k, title] of Object.entries(HEADERS) as [Col, string][]) {
        if (found[k] === undefined && (h === title || h.startsWith(`${title} `) || h.startsWith(`${title},`) || h.startsWith(`${title}(`))) found[k] = c;
      }
    });
    if (found.sku && found.expiry && found.qty) {
      headerRow = r;
      Object.assign(cols, found);
    }
  }
  if (!headerRow) {
    error(0, `на листе «${OPENING_SHEET}» не найдены заголовки «SKU», «Срок годности», «Количество банок»`);
    return plan;
  }

  // Rows -> per SKU: expiry groups (as typed)
  const bySku = new Map<string, { row: number; groups: { expiry: string; qty: number }[] }>();
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const sku = cellText(row.getCell(cols.sku!).value);
    const rawExpiry = row.getCell(cols.expiry!).value;
    const qty = cellInt(row.getCell(cols.qty!).value);
    if (!sku && qty === null && !cellText(rawExpiry)) continue; // empty row
    if (!sku) {
      error(r, 'не указан SKU');
      continue;
    }
    if (qty === null || qty === 'bad') {
      error(r, `«Количество банок»: нужно целое число больше 0 (сейчас «${cellText(row.getCell(cols.qty!).value)}»)`, sku);
      continue;
    }
    const day = cellDay(rawExpiry);
    if (!day) {
      error(r, `«Срок годности»: нужна дата ДД.ММ.ГГГГ (сейчас «${cellText(rawExpiry)}»)`, sku);
      continue;
    }
    if (day < today) {
      error(r, `срок годности ${ruDay(day)} уже прошёл — такие банки уберите из листа и спишите отдельно`, sku);
      continue;
    }
    const entry = bySku.get(sku) ?? { row: r, groups: [] };
    entry.groups.push({ expiry: day, qty });
    bySku.set(sku, entry);
  }
  if (!bySku.size && !plan.errors.length) error(0, 'на листе нет строк с товарами');

  const products = await prisma.products.findMany({ where: { sku: { in: [...bySku.keys()] } }, include: { inventory: true } });
  const openOpening = await prisma.physical_units.findMany({
    where: { status: 'RECEIVED', product_id: { in: products.map((p) => p.id) }, receiving_session: { type: 'OPENING_BALANCE', status: 'OPEN' } },
    select: { product_id: true },
    distinct: ['product_id'],
  });
  const receivingNow = await prisma.physical_units.findMany({
    where: { status: 'RECEIVED', product_id: { in: products.map((p) => p.id) }, receiving_session: { type: 'PURCHASE', status: 'OPEN' } },
    select: { product_id: true },
    distinct: ['product_id'],
  });
  const inStock = await prisma.physical_units.groupBy({
    by: ['product_id', 'expiry_date'],
    where: { status: 'IN_STOCK', product_id: { in: products.map((p) => p.id) } },
    _count: { _all: true },
  });

  for (const [sku, { row, groups }] of bySku) {
    const p = products.find((x) => x.sku === sku);
    if (!p) {
      error(row, 'товара с таким SKU нет в базе', sku);
      continue;
    }
    const sheetQty = groups.reduce((s, g) => s + g.qty, 0);
    const checked = checkExpiryGroups(groups, sheetQty, today);
    const merged = 'groups' in checked ? checked.groups : [];
    const actual = p.inventory.reduce((s, i) => s + i.actual_qty, 0);
    const reserved = p.inventory.reduce((s, i) => s + i.reserved_qty, 0);
    const existing = new Map(inStock.filter((u) => u.product_id === p.id).map((u) => [u.expiry_date.toISOString().slice(0, 10), u._count._all]));
    const existingUnits = [...existing.values()].reduce((s, n) => s + n, 0);
    const newGroups = merged.map((g) => ({ expiry: g.expiry, qty: g.qty - (existing.get(g.expiry) ?? 0) })).filter((g) => g.qty !== 0);
    const r: OpeningRowPlan = {
      sku,
      productId: p.id,
      name: p.name_ru,
      actual,
      reserved,
      sheetQty,
      difference: sheetQty - actual,
      cost: p.cost_uzs == null ? null : Number(p.cost_uzs),
      groups: merged,
      existingUnits,
      newGroups,
      newUnits: newGroups.reduce((s, g) => s + g.qty, 0),
      action: 'create',
    };
    plan.rows.push(r);
    const fail = (message: string) => {
      r.action = 'error';
      r.note = message;
      error(row, message, sku);
    };
    if (p.unit_tracking) {
      r.action = 'skip';
      r.note = 'уже учитывается по единицам — пропущен';
      warn(row, r.note, sku);
      continue;
    }
    if (openOpening.some((u) => u.product_id === p.id)) {
      r.action = 'skip';
      r.note = 'уже в незавершённой сессии начального остатка — завершите её в админке (Склад → Приёмка)';
      warn(row, r.note, sku);
      continue;
    }
    if (p.status === 'archived') fail('товар в архиве');
    else if (r.cost == null) fail('не заполнена себестоимость (cost_uzs) — без неё единицы не создаются');
    else if (reserved > sheetQty) fail(`в резерве по заказам ${reserved} шт., а банок на листе ${sheetQty} — сначала разберитесь с заказами`);
    else if (receivingNow.some((u) => u.product_id === p.id)) fail('по товару идёт приёмка закупки — завершите или отмените её перед вводом начального остатка');
    else if (newGroups.some((g) => g.qty < 0) || [...existing.keys()].some((d) => !merged.some((g) => g.expiry === d))) {
      fail(`банок на листе меньше, чем уже есть единиц с Physical ID (${existingUnits}) — проверьте сроки годности по листу`);
    } else if (r.newUnits === 0) {
      r.action = 'skip';
      r.note = 'все банки уже имеют Physical ID — создавать нечего';
      warn(row, r.note, sku);
    }
  }
  return plan;
}

// ---------------------------------------------------------------- applying (writes)

export async function applyOpeningStock(prisma: PrismaService, audit: AuditService, plan: OpeningPlan): Promise<OpeningResult> {
  if (plan.errors.length) throw new Error('В листе есть ошибки — исправьте их и запустите проверку ещё раз. Ничего не записано.');
  const rows = plan.rows.filter((r) => r.action === 'create');
  if (!rows.length) return { sessionId: null, created: [] };
  return prisma.$transaction(
    async (tx) => {
      const open = await tx.receiving_sessions.findFirst({ where: { type: 'OPENING_BALANCE', status: 'OPEN' } });
      const session = open ?? (await tx.receiving_sessions.create({ data: { type: 'OPENING_BALANCE' } }));
      const created: OpeningResult['created'] = [];
      for (const r of rows) {
        // Checked again inside the transaction: nobody added units of this product since the plan was made.
        const already = await tx.physical_units.count({ where: { product_id: r.productId, status: 'RECEIVED' } });
        if (already) throw new Error(`${r.sku}: появились незавершённые единицы — запустите проверку ещё раз. Ничего не записано.`);
        const units = unitExpiries(r.newGroups).map((expiry) => ({ product_id: r.productId, purchase_id: null, purchase_line_id: null, cost: BigInt(r.cost!), expiry }));
        const ids = await createUnits(tx, session.id, units, null);
        await tx.receiving_session_lines.create({
          data: { session_id: session.id, product_id: r.productId, qty: r.newUnits, expiry_date_groups: auditJson(r.newGroups) },
        });
        created.push({ sku: r.sku, units: ids.length, first: ids[0].physical_id, last: ids[ids.length - 1].physical_id });
      }
      await audit.log({ staffId: null, action: 'receiving.opening_imported', entityType: 'receiving_session', entityId: session.id, after: { file: plan.file, created } }, tx);
      return { sessionId: session.id, created };
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
}

// ---------------------------------------------------------------- report

const groupsText = (gs: ExpiryGroup[]) => gs.map((g) => `${ruDay(g.expiry)} × ${g.qty}`).join(', ') || '—';

export function formatOpeningPlan(plan: OpeningPlan): string {
  const out: string[] = [];
  for (const r of plan.rows) {
    const mark = r.action === 'create' ? '+' : r.action === 'skip' ? '·' : '✗';
    out.push(`${mark} ${r.sku} — ${r.name}`);
    out.push(`    в базе: остаток ${r.actual}, в резерве ${r.reserved}; по листу банок ${r.sheetQty}; разница ${r.difference > 0 ? '+' : ''}${r.difference}`);
    out.push(`    себестоимость единицы: ${r.cost == null ? '— (НЕ ЗАПОЛНЕНА)' : `${r.cost} сум`}; сроки: ${groupsText(r.groups)}`);
    if (r.existingUnits) out.push(`    уже с Physical ID: ${r.existingUnits}; будет создано: ${r.newUnits} (${groupsText(r.newGroups)})`);
    else if (r.action === 'create') out.push(`    будет создано единиц: ${r.newUnits}`);
    if (r.note) out.push(`    ${r.note}`);
  }
  const creating = plan.rows.filter((r) => r.action === 'create');
  out.push('');
  out.push(`Итого: товаров ${plan.rows.length}, к созданию ${creating.length}, единиц ${creating.reduce((s, r) => s + r.newUnits, 0)}.`);
  if (plan.warnings.length) {
    out.push('', `Предупреждения (${plan.warnings.length}):`);
    for (const w of plan.warnings) out.push(`  строка ${w.row}${w.sku ? ` (${w.sku})` : ''}: ${w.message}`);
  }
  if (plan.errors.length) {
    out.push('', `ОШИБКИ (${plan.errors.length}) — пока они есть, ничего не записывается:`);
    for (const e of plan.errors) out.push(`  ${e.row ? `строка ${e.row}` : 'файл'}${e.sku ? ` (${e.sku})` : ''}: ${e.message}`);
  }
  return out.join('\n');
}

export function formatOpeningResult(res: OpeningResult): string {
  if (!res.sessionId) return 'Создавать нечего: все товары пропущены.';
  const out = [`Создана (дополнена) сессия начального остатка ${res.sessionId}:`];
  for (const c of res.created) out.push(`  ${c.sku}: ${c.units} шт., ${c.first} … ${c.last}`);
  out.push(
    '',
    'Дальше в админке (администратор): Склад → Приёмка → Незавершённые приёмки → «Продолжить»:',
    'напечатайте и наклейте этикетки, затем «Завершить приёмку». Только тогда остаток станет равен числу единиц,',
    'а товары перейдут на учёт по единицам.',
  );
  return out.join('\n');
}
