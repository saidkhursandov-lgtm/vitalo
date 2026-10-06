/**
 * Stage 1.2: links products to the dictionaries (brand / manufacturer / country / form) by their text.
 *
 *   npm run backfill:dictionaries                 -> check only (dry run), writes nothing
 *   npm run backfill:dictionaries -- --confirm    -> creates missing dictionary values and fills empty *_id
 *
 * Only *_dev / *_test databases; any other needs --allow-production and the database name typed in.
 * The text columns of products are never changed. See src/import/dictionary-backfill.ts.
 */
import 'dotenv/config';
import { assertDataScriptTarget } from '../src/common/db-target';
import { applyBackfill, formatBackfillPlan, formatBackfillResult, planBackfill } from '../src/import/dictionary-backfill';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/staff/audit.service';

async function main() {
  await assertDataScriptTarget('npm run backfill:dictionaries');
  const confirm = process.argv.includes('--confirm');
  const prisma = new PrismaService();
  try {
    const plan = await planBackfill(prisma);
    console.log(confirm ? 'ЗАПИСЬ\n' : 'ПРОВЕРКА (--dry-run): в базу ничего не записывается\n');
    console.log(formatBackfillPlan(plan));
    if (!confirm) {
      console.log('\nЧтобы записать: npm run backfill:dictionaries -- --confirm');
      return;
    }
    console.log('\n' + formatBackfillResult(await applyBackfill(prisma, new AuditService(prisma), plan)));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
