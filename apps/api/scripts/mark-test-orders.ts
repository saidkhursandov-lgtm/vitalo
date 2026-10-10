/**
 * Stage 3: mark test orders, so they are in no analytics, tax or summary.
 *
 *   npm run orders:mark-test                                   -> check only (dry run): prints the lists, writes nothing
 *   npm run orders:mark-test -- --numbers=VTL-...,VTL-...      -> the same, plus the named orders
 *   npm run orders:mark-test -- --confirm [--numbers=...]      -> marks Yandex TEST-* and the named orders
 *
 * Only *_dev / *_test databases (never the server's database). An order can be unmarked in its card (admin).
 */
import 'dotenv/config';
import { assertDevOrTestDatabase, printDbBanner } from '../src/common/db-target';
import { formatTestOrdersPlan, markTestOrders, planTestOrders } from '../src/finance/mark-test-orders';
import { PrismaService } from '../src/prisma/prisma.service';

async function main() {
  assertDevOrTestDatabase('npm run orders:mark-test');
  printDbBanner('npm run orders:mark-test');
  const confirm = process.argv.includes('--confirm');
  const numbers = (process.argv.find((a) => a.startsWith('--numbers='))?.slice('--numbers='.length) ?? '').split(',').filter(Boolean);
  const prisma = new PrismaService();
  try {
    const plan = await planTestOrders(prisma, numbers);
    console.log(confirm ? 'ЗАПИСЬ\n' : 'ПРОВЕРКА (--dry-run): в базу ничего не записывается\n');
    console.log(formatTestOrdersPlan(plan));
    if (!confirm) {
      console.log('\nЧтобы пометить заказы из пунктов 1 и 3: добавьте --confirm.');
      return;
    }
    if (plan.unknown.length) {
      console.log('\nОСТАНОВЛЕНО: часть номеров из --numbers не найдена. Ничего не изменено — исправьте список.');
      process.exitCode = 1;
      return;
    }
    const done = await markTestOrders(prisma, plan);
    console.log(`\nГОТОВО: помечено тестовыми ${done.length} заказ(ов).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
