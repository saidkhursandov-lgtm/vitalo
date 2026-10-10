/**
 * Stage 2E, one-off: Mini App orders of unit-tracked products paid before stage 2E (no units attached).
 *
 *   npm run orders:attach-units                -> check only (dry run), writes nothing
 *   npm run orders:attach-units -- --confirm   -> attaches units to the paid, not yet shipped orders
 *
 * Only *_dev / *_test databases (never the server's database). See src/orders/attach-legacy-units.ts.
 */
import 'dotenv/config';
import { assertDevOrTestDatabase, printDbBanner } from '../src/common/db-target';
import { StockService } from '../src/inventory/stock.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { attachLegacyOrders, formatLegacyPlan, planLegacyOrders } from '../src/orders/attach-legacy-units';
import { OrderUnitsService } from '../src/orders/order-units.service';
import { PrismaService } from '../src/prisma/prisma.service';

async function main() {
  assertDevOrTestDatabase('npm run orders:attach-units');
  printDbBanner('npm run orders:attach-units');
  const confirm = process.argv.includes('--confirm');
  const prisma = new PrismaService();
  try {
    const stock = new StockService(prisma);
    const plan = await planLegacyOrders(prisma, stock);
    console.log(confirm ? 'ЗАПИСЬ\n' : 'ПРОВЕРКА (--dry-run): в базу ничего не записывается\n');
    console.log(formatLegacyPlan(plan));
    if (!confirm) {
      if (plan.attach.length) console.log('\nЧтобы закрепить банки: добавьте --confirm.');
      return;
    }
    const res = await attachLegacyOrders(prisma, stock, new OrderUnitsService(stock, new NotificationsService(prisma)), plan);
    console.log(`\nГОТОВО: банки закреплены у ${res.done.length} заказ(ов).`);
    for (const d of res.done) console.log(`  ${d.order_number}: ${d.reserved.join(', ')}`);
    if (res.failed.length) {
      console.log(`Не удалось (ничего не изменено): ${res.failed.length}`);
      for (const f of res.failed) console.log(`  ${f.order_number}: ${f.reason}`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
