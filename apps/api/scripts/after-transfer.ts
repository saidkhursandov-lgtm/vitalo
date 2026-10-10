/**
 * Block E: run ONCE on the server right after the copy of the development database was restored there and BEFORE
 * the services are started (docs/DEPLOY_RUNBOOK.md, phase 3).
 *
 *   npm run server:after-transfer                                  -> check only (dry run), writes nothing
 *   npm run server:after-transfer -- --confirm --database=vitalo   -> does it; the name must be the database of DATABASE_URL
 *
 * Switches off what must not travel with the copy (queued messages, sign-ins, demo employees) and prints what to
 * check. Deletes no order, unit or history row. See src/ops/after-transfer.ts.
 */
import 'dotenv/config';
import { dbTarget, describeDb } from '../src/common/db-target';
import { applyAfterTransfer, formatAfterTransferPlan, planAfterTransfer } from '../src/ops/after-transfer';
import { PrismaService } from '../src/prisma/prisma.service';

async function main() {
  const target = dbTarget(process.env.DATABASE_URL);
  console.log(`=== npm run server:after-transfer: база ${describeDb(target)}${process.env.NODE_ENV ? `, NODE_ENV=${process.env.NODE_ENV}` : ''} ===`);
  const confirm = process.argv.includes('--confirm');
  const named = process.argv.find((a) => a.startsWith('--database='))?.slice('--database='.length);
  if (confirm && named !== target.database) {
    throw new Error(`Для записи укажите базу явно: --database=${target.database} (сейчас указано: ${named ?? 'ничего'}). Остановлено, ничего не изменено.`);
  }
  const prisma = new PrismaService();
  try {
    const plan = await planAfterTransfer(prisma, target.database);
    console.log(confirm ? 'ЗАПИСЬ\n' : 'ПРОВЕРКА (--dry-run): в базу ничего не записывается\n');
    console.log(formatAfterTransferPlan(plan));
    if (!confirm) {
      console.log(`\nЧтобы выполнить: добавьте --confirm --database=${target.database}`);
      return;
    }
    const done = await applyAfterTransfer(prisma, plan);
    console.log(`\nГОТОВО: сообщений пропущено ${done.notifications_skipped}, входов удалено ${done.user_sessions_removed + done.staff_sessions_removed}, демо-сотрудников заблокировано ${done.seed_staff_blocked}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
