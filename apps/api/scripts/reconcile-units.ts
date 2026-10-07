/**
 * Stage 2B «Сверка» in the terminal: per unit-tracked product, units IN_STOCK vs the stock (actual / reserved).
 * Read only: writes nothing to any database.
 *
 *   npm run reconcile:units
 *
 * See src/receiving/reconcile.ts.
 */
import 'dotenv/config';
import { printDbBanner } from '../src/common/db-target';
import { PrismaService } from '../src/prisma/prisma.service';
import { formatReconcile, reconcileUnits } from '../src/receiving/reconcile';

async function main() {
  printDbBanner('npm run reconcile:units (только чтение)');
  const prisma = new PrismaService();
  try {
    const rows = await reconcileUnits(prisma);
    console.log(formatReconcile(rows));
    if (rows.some((r) => !r.explained)) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
