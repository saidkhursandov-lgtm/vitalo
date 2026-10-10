import type { PrismaClient } from '@prisma/client';
import { formatUzs, tashkentDateString } from '../common/tashkent';

/**
 * Block E (the move to the server), `npm run server:after-transfer`: what must be made safe right after a copy of
 * the development database became the database of the shop — BEFORE the services are started.
 *
 * It only switches things off; no order, unit, stock movement or history row is deleted (S-E-3):
 *  - messages still waiting in the queue would be sent by the production bot → marked «skipped»;
 *  - sign-ins made on the developer's computer → removed (everybody signs in again);
 *  - stored answers of repeated requests (idempotency keys) → removed;
 *  - the four demo employees of the seed (Telegram ids 222222221…224) → blocked.
 * Everything else is only listed, so the owner can check it.
 */
export const SEED_STAFF_TELEGRAM_IDS = [222_222_221n, 222_222_222n, 222_222_223n, 222_222_224n];

export interface AfterTransferPlan {
  database: string;
  queuedNotifications: number;
  userSessions: number;
  staffSessions: number;
  idempotencyKeys: number;
  seedStaff: { id: string; name: string; role: string }[];
  // ---- for the owner to look through (nothing of this is changed)
  staff: { name: string; role: string; status: string; seed: boolean }[];
  counts: { products: number; unitsOnShelf: number; unitsTotal: number; customers: number; aliases: number };
  orders: { vitalo: number; vitaloTest: number; yandex: number; yandexTest: number };
  notTestOrders: { channel: string; number: string; day: string; status: string; total: number }[];
  warnings: string[];
}

const OPEN_VITALO = ['new', 'awaiting_payment', 'paid', 'picking', 'handed_to_delivery', 'in_transit'] as const;

export async function planAfterTransfer(prisma: PrismaClient, database: string): Promise<AfterTransferPlan> {
  const staff = await prisma.staff_users.findMany({ orderBy: { created_at: 'asc' } });
  const isSeed = (id: bigint) => SEED_STAFF_TELEGRAM_IDS.includes(id);
  const vitalo = await prisma.orders.findMany({ where: { is_test: false }, orderBy: { created_at: 'asc' } });
  const yandex = await prisma.marketplace_orders.findMany({ where: { is_test: false }, include: { lines: true }, orderBy: { created_at: 'asc' } });

  const warnings: string[] = [];
  const card = (await prisma.settings.findUnique({ where: { key: 'card_transfer_details' } }))?.value as { recipient?: string } | null;
  if (!card || /ТЕСТ/i.test(card.recipient ?? '')) warnings.push('Настройки → «Перевод на карту»: стоят ТЕСТОВЫЕ данные карты — внесите настоящие до открытия.');
  if (!(await prisma.settings.findUnique({ where: { key: 'bank_transfer_details' } }))) warnings.push('Настройки → «Перевод по реквизитам»: реквизиты не заполнены.');
  const testTariffs = await prisma.delivery_tariffs.count({ where: { is_test: true, status: 'active' } });
  if (testTariffs) warnings.push(`Доставка: ${testTariffs} тариф(ов) с отметкой «тестовый» — проверьте цены и сроки, снимите отметку.`);
  const legal = await prisma.legal_documents.findMany({ where: { status: 'active' } });
  for (const d of legal) if (/test/i.test(d.version)) warnings.push(`Документы: действует тестовая версия «${d.code}» ${d.version} — опубликуйте версию, проверенную юристом.`);
  if (!legal.length) warnings.push('Документы: нет ни одного опубликованного юридического текста.');
  if (!staff.some((s) => s.role === 'admin' && s.status === 'active' && !isSeed(s.telegram_user_id))) {
    warnings.push('Нет ни одного настоящего активного администратора: добавьте себя командой npm run staff:add.');
  }
  const open = vitalo.filter((o) => (OPEN_VITALO as readonly string[]).includes(o.status)).length + yandex.filter((o) => ['NEW', 'ASSEMBLED', 'HANDED_TO_DELIVERY'].includes(o.status)).length;
  if (open) warnings.push(`Есть ${open} незавершённых заказ(ов) без пометки «тест» — если они тестовые, пометьте их; настоящие заказы Яндекса оставьте как есть.`);

  return {
    database,
    queuedNotifications: await prisma.notifications.count({ where: { status: { in: ['queued', 'sending'] } } }),
    userSessions: await prisma.user_sessions.count(),
    staffSessions: await prisma.staff_sessions.count(),
    idempotencyKeys: await prisma.idempotency_keys.count(),
    seedStaff: staff.filter((s) => isSeed(s.telegram_user_id) && s.status === 'active').map((s) => ({ id: s.id, name: s.name, role: s.role })),
    staff: staff.map((s) => ({ name: s.name, role: s.role, status: s.status, seed: isSeed(s.telegram_user_id) })),
    counts: {
      products: await prisma.products.count({ where: { status: { not: 'archived' } } }),
      unitsOnShelf: await prisma.physical_units.count({ where: { status: { in: ['IN_STOCK', 'ASSIGNED'] } } }),
      unitsTotal: await prisma.physical_units.count(),
      customers: await prisma.users.count(),
      aliases: await prisma.product_sku_aliases.count(),
    },
    orders: {
      vitalo: await prisma.orders.count(),
      vitaloTest: await prisma.orders.count({ where: { is_test: true } }),
      yandex: await prisma.marketplace_orders.count(),
      yandexTest: await prisma.marketplace_orders.count({ where: { is_test: true } }),
    },
    notTestOrders: [
      ...vitalo.map((o) => ({ channel: 'VITALO', number: o.order_number, day: tashkentDateString(o.created_at), status: o.status as string, total: Number(o.total_uzs) })),
      ...yandex.map((o) => ({ channel: 'Яндекс', number: o.external_number, day: tashkentDateString(o.created_at), status: o.status as string, total: o.lines.reduce((s, l) => s + Number(l.unit_price_uzs) * l.qty, 0) })),
    ],
    warnings,
  };
}

export function formatAfterTransferPlan(p: AfterTransferPlan): string {
  const out: string[] = [];
  out.push(`База: ${p.database}`);
  out.push('', 'БУДЕТ СДЕЛАНО при --confirm (заказы, банки, остатки и история НЕ меняются):');
  out.push(`  • сообщений в очереди, которые бот мог бы отправить: ${p.queuedNotifications} → станут «пропущено»`);
  out.push(`  • входов покупателей: ${p.userSessions}, входов сотрудников: ${p.staffSessions} → удалятся (все войдут заново)`);
  out.push(`  • сохранённых ответов на повторные запросы: ${p.idempotencyKeys} → удалятся`);
  out.push(`  • демо-сотрудников из тестового набора: ${p.seedStaff.length} → будут заблокированы${p.seedStaff.length ? `: ${p.seedStaff.map((s) => s.name).join(', ')}` : ''}`);
  out.push('', 'ДЛЯ СВЕРКИ (не меняется):');
  out.push(`  Товаров: ${p.counts.products}, альтернативных SKU: ${p.counts.aliases}, покупателей: ${p.counts.customers}`);
  out.push(`  Банок всего: ${p.counts.unitsTotal}, из них на полке (На складе + Зарезервирована): ${p.counts.unitsOnShelf}`);
  out.push(`  Заказов VITALO: ${p.orders.vitalo} (тестовых ${p.orders.vitaloTest}); заказов Яндекса: ${p.orders.yandex} (тестовых ${p.orders.yandexTest})`);
  out.push('  Сотрудники:');
  for (const s of p.staff) out.push(`    ${s.name} — ${s.role}, ${s.status === 'active' ? 'активен' : 'заблокирован'}${s.seed ? ' (демо)' : ''}`);
  out.push(`  Заказы БЕЗ пометки «тест»: ${p.notTestOrders.length}`);
  for (const o of p.notTestOrders.slice(0, 200)) out.push(`    ${o.channel.padEnd(7)} ${o.number.padEnd(22)} ${o.day}  ${o.status.padEnd(20)} ${formatUzs(o.total)} сум`);
  if (p.notTestOrders.length > 200) out.push(`    …и ещё ${p.notTestOrders.length - 200}`);
  out.push('', p.warnings.length ? 'ЧТО ПРОВЕРИТЬ ДО ОТКРЫТИЯ:' : 'Замечаний нет.');
  for (const w of p.warnings) out.push(`  ! ${w}`);
  return out.join('\n');
}

/** One transaction; an audit row («скрипт», no employee) says what was done. */
export async function applyAfterTransfer(prisma: PrismaClient, plan: AfterTransferPlan) {
  return prisma.$transaction(async (tx) => {
    const notifications = await tx.notifications.updateMany({ where: { status: { in: ['queued', 'sending'] } }, data: { status: 'skipped', error: 'Перенос базы на сервер: не отправлено' } });
    const userSessions = await tx.user_sessions.deleteMany({});
    const staffSessions = await tx.staff_sessions.deleteMany({});
    const idempotencyKeys = await tx.idempotency_keys.deleteMany({});
    const blocked = await tx.staff_users.updateMany({ where: { id: { in: plan.seedStaff.map((s) => s.id) } }, data: { status: 'blocked' } });
    const done = { notifications_skipped: notifications.count, user_sessions_removed: userSessions.count, staff_sessions_removed: staffSessions.count, idempotency_keys_removed: idempotencyKeys.count, seed_staff_blocked: blocked.count };
    await tx.audit_logs.create({ data: { staff_user_id: null, action: 'server.after_transfer', entity_type: 'settings', after_json: { ...done, database: plan.database, by: 'npm run server:after-transfer' } } });
    return done;
  });
}
