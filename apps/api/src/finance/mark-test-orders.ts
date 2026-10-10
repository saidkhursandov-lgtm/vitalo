import type { PrismaClient } from '@prisma/client';
import { formatUzs, tashkentDateString } from '../common/tashkent';

/**
 * Stage 3, `npm run orders:mark-test`: which orders look like test ones.
 * - Yandex: the number starts with TEST- (typed by hand while trying the system) — marked by --confirm.
 * - Mini App (VTL-…): the system cannot know which ones were tests, so ALL not marked orders are only listed;
 *   the owner checks the list and names the test ones with --numbers=VTL-…,VTL-… (nothing is guessed).
 */
export interface TestOrderRow {
  channel: 'yandex' | 'vitalo';
  id: string;
  number: string;
  day: string;
  status: string;
  total: number;
}

export interface TestOrdersPlan {
  /** Yandex TEST-* not marked yet */
  yandexTest: TestOrderRow[];
  /** every Mini App order not marked yet (to look through) */
  vitaloAll: TestOrderRow[];
  /** orders named with --numbers and found (either channel), not marked yet */
  named: TestOrderRow[];
  /** numbers from --numbers that are not in the database (or are already marked) */
  unknown: string[];
  alreadyMarked: number;
}

export async function planTestOrders(prisma: PrismaClient, numbers: string[] = []): Promise<TestOrdersPlan> {
  const yandex = await prisma.marketplace_orders.findMany({ where: { is_test: false }, include: { lines: true }, orderBy: { created_at: 'asc' } });
  const vitalo = await prisma.orders.findMany({ where: { is_test: false }, orderBy: { created_at: 'asc' } });
  const y: TestOrderRow[] = yandex.map((o) => ({
    channel: 'yandex',
    id: o.id,
    number: o.external_number,
    day: tashkentDateString(o.created_at),
    status: o.status,
    total: o.lines.reduce((s, l) => s + Number(l.unit_price_uzs) * l.qty, 0),
  }));
  const v: TestOrderRow[] = vitalo.map((o) => ({ channel: 'vitalo', id: o.id, number: o.order_number, day: tashkentDateString(o.created_at), status: o.status, total: Number(o.total_uzs) }));
  const wanted = new Set(numbers.map((n) => n.trim().toUpperCase()).filter(Boolean));
  const named = [...y, ...v].filter((r) => wanted.has(r.number.toUpperCase()));
  const found = new Set(named.map((r) => r.number.toUpperCase()));
  const alreadyMarked = (await prisma.marketplace_orders.count({ where: { is_test: true } })) + (await prisma.orders.count({ where: { is_test: true } }));
  return { yandexTest: y.filter((r) => /^TEST-/i.test(r.number)), vitaloAll: v, named, unknown: [...wanted].filter((n) => !found.has(n)), alreadyMarked };
}

const line = (r: TestOrderRow) => `  ${r.number.padEnd(22)} ${r.day}  ${r.status.padEnd(20)} ${formatUzs(r.total)} сум`;

export function formatTestOrdersPlan(plan: TestOrdersPlan): string {
  const out: string[] = [];
  out.push(`Уже помечены как тестовые: ${plan.alreadyMarked}`);
  out.push('', `1) Заказы Яндекса с номером TEST-… (будут помечены при --confirm): ${plan.yandexTest.length}`);
  out.push(...plan.yandexTest.map(line));
  out.push('', `2) Заказы VITALO (VTL-…), ещё не помеченные: ${plan.vitaloAll.length}`);
  out.push('   Система не знает, какие из них тестовые. Сверьте список и перечислите тестовые в --numbers=VTL-…,VTL-…');
  out.push(...plan.vitaloAll.map(line));
  if (plan.named.length || plan.unknown.length) {
    out.push('', `3) Названы в --numbers (будут помечены при --confirm): ${plan.named.length}`);
    out.push(...plan.named.map(line));
    if (plan.unknown.length) out.push(`   НЕ НАЙДЕНЫ или уже помечены: ${plan.unknown.join(', ')}`);
  }
  return out.join('\n');
}

/** Marks Yandex TEST-* and the named orders; every one is written to the audit log («скрипт», no employee). */
export async function markTestOrders(prisma: PrismaClient, plan: TestOrdersPlan): Promise<TestOrderRow[]> {
  const rows = [...new Map([...plan.yandexTest, ...plan.named].map((r) => [`${r.channel}|${r.id}`, r])).values()];
  await prisma.$transaction(async (tx) => {
    for (const r of rows) {
      if (r.channel === 'yandex') await tx.marketplace_orders.update({ where: { id: r.id }, data: { is_test: true } });
      else await tx.orders.update({ where: { id: r.id }, data: { is_test: true } });
      await tx.audit_logs.create({
        data: { staff_user_id: null, action: 'order.marked_test', entity_type: r.channel === 'yandex' ? 'marketplace_order' : 'order', entity_id: r.id, before_json: { is_test: false }, after_json: { is_test: true, by: 'npm run orders:mark-test', number: r.number } },
      });
    }
  });
  return rows;
}
