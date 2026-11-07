/**
 * Loading the master table docs/content/VITALO_catalog.xlsx into the database.
 *
 *   npm run catalog:load                          -> the plan only: check, «было → стало», SKUs of new products; writes nothing
 *   npm run catalog:load -- --confirm             -> writes (one transaction: all or nothing)
 *   --file <xlsx>   default docs/content/VITALO_catalog.xlsx
 *   --out <md>      also save the plan to a file
 *
 * Only *_dev / *_test databases; any other needs --allow-production and the database name typed in the terminal.
 * Before --confirm on vitalo_dev: a copy of the database (pg_dump) — see docs. See src/import/catalog-master-load.ts.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { assertDataScriptTarget } from '../src/common/db-target';
import { formatCatalogCheck, readCatalogFile } from '../src/import/catalog-master';
import { applyCatalogLoad, formatLoadPlan, formatLoadResult, planCatalogLoad } from '../src/import/catalog-master-load';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/staff/audit.service';

const ROOT = resolve(__dirname, '../../..');

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  await assertDataScriptTarget(confirm ? 'npm run catalog:load (ЗАПИСЬ)' : 'npm run catalog:load (только план)');
  const file = resolve(argValue('--file') ?? join(ROOT, 'docs/content/VITALO_catalog.xlsx'));
  const prisma = new PrismaService();
  try {
    const plan = await planCatalogLoad(prisma, await readCatalogFile(file));
    const blocked = plan.check.errors.length + plan.errors.length > 0;
    const text = [
      confirm ? 'ЗАПИСЬ В БАЗУ' : 'ПЛАН: в базу ничего не записывается',
      `Файл: ${file}`,
      '',
      formatLoadPlan(plan),
      formatCatalogCheck(plan.check),
    ].join('\n');
    console.log(text);
    const out = argValue('--out');
    if (out) {
      writeFileSync(out, text + '\n');
      console.log(`План сохранён: ${resolve(out)}`);
    }
    if (blocked) {
      process.exitCode = 1;
      console.log('\nЕсть ошибки — ничего не записано.');
      return;
    }
    if (!confirm) {
      console.log('\nЧтобы записать: npm run catalog:load -- --confirm');
      return;
    }
    console.log('\nГОТОВО\n' + formatLoadResult(await applyCatalogLoad(prisma, new AuditService(prisma), plan)));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
