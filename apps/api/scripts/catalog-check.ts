/**
 * Check of the master table docs/content/VITALO_catalog.xlsx before loading — the database is only READ (one READ ONLY
 * transaction), nothing is written anywhere except the report file.
 *
 *   npm run catalog:check                         -> errors, UZ translations to check, «было → стало», warnings
 *   npm run catalog:check -- --out report.md      -> the same, also saved to a file
 *   --file <xlsx>   default docs/content/VITALO_catalog.xlsx
 *
 * Exit code 1 when the table has errors. See src/import/catalog-master.ts.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { printDbBanner } from '../src/common/db-target';
import { checkCatalog, formatCatalogCheck, loadCatalogDb, readCatalogFile } from '../src/import/catalog-master';
import { PrismaService } from '../src/prisma/prisma.service';

const ROOT = resolve(__dirname, '../../..');

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  printDbBanner('npm run catalog:check (только чтение)');
  const file = resolve(argValue('--file') ?? join(ROOT, 'docs/content/VITALO_catalog.xlsx'));
  const sheets = await readCatalogFile(file);
  const prisma = new PrismaService();
  try {
    const result = checkCatalog(sheets, await loadCatalogDb(prisma));
    const text = `ПРОВЕРКА: в базу ничего не записывается\nФайл: ${file}\n\n${formatCatalogCheck(result)}`;
    console.log(text);
    const out = argValue('--out');
    if (out) {
      writeFileSync(out, text + '\n');
      console.log(`Отчёт сохранён: ${resolve(out)}`);
    }
    if (result.errors.length) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
