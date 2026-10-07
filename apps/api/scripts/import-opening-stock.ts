/**
 * Stage 2B.3: opening balance in units from the stock count sheet «Начальные остатки (банки)».
 *
 *   npm run import:opening-stock                         -> check only (dry run), writes nothing
 *   npm run import:opening-stock -- --confirm            -> writes (all or nothing): an open opening-balance session
 *   npm run import:opening-stock -- <file.xlsx>          -> another file (default: VITALO_каталог_единая_таблица.xlsx
 *                                                           in the project root); --file <path> works too
 *
 * Only *_dev / *_test databases; any other needs --allow-production and the database name typed in.
 * After --confirm: admin panel -> Склад -> Приёмка -> Незавершённые: print labels, then «Завершить».
 * See src/import/opening-stock.ts.
 */
import 'dotenv/config';
import { resolve } from 'path';
import { assertDataScriptTarget } from '../src/common/db-target';
import { applyOpeningStock, formatOpeningPlan, formatOpeningResult, planOpeningStock } from '../src/import/opening-stock';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/staff/audit.service';

const ROOT = resolve(__dirname, '..', '..', '..');

function fileArg(): string {
  const args = process.argv.slice(2);
  const i = args.indexOf('--file');
  if (i >= 0 && args[i + 1]) return resolve(args[i + 1]);
  const positional = args.find((a, k) => !a.startsWith('--') && args[k - 1] !== '--file');
  return positional ? resolve(positional) : resolve(ROOT, 'VITALO_каталог_единая_таблица.xlsx');
}

async function main() {
  await assertDataScriptTarget('npm run import:opening-stock');
  const confirm = process.argv.includes('--confirm');
  const file = fileArg();
  const prisma = new PrismaService();
  try {
    const plan = await planOpeningStock(prisma, file);
    console.log(confirm ? 'ЗАПИСЬ\n' : 'ПРОВЕРКА (--dry-run): в базу ничего не записывается\n');
    console.log(`Файл: ${file}\n`);
    console.log(formatOpeningPlan(plan));
    if (!confirm) {
      if (!plan.errors.length) console.log('\nЧтобы записать: npm run import:opening-stock -- --confirm');
      return;
    }
    if (plan.errors.length) throw new Error('\nЕсть ошибки — ничего не записано.');
    console.log('\n' + formatOpeningResult(await applyOpeningStock(prisma, new AuditService(prisma), plan)));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
