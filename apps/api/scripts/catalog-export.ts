/**
 * The database → the master table docs/content/VITALO_catalog.xlsx. The database is only READ (one READ ONLY
 * transaction); the file is rewritten: columns that come from the database, the sheets «Вещества» and «Правила
 * совместимости», drop-down lists. The owner's columns without a database field, comments and brand texts stay.
 *
 *   npm run catalog:export                        -> rewrites docs/content/VITALO_catalog.xlsx (a copy *.before-export.xlsx is kept)
 *   npm run catalog:export -- --out other.xlsx    -> writes another file, the template stays as it is
 *   --file <xlsx>   the template (default docs/content/VITALO_catalog.xlsx)
 *
 * See src/import/catalog-master-export.ts.
 */
import 'dotenv/config';
import { copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { printDbBanner } from '../src/common/db-target';
import { loadCatalogDb } from '../src/import/catalog-master';
import { writeCatalogWorkbook } from '../src/import/catalog-master-export';
import { PrismaService } from '../src/prisma/prisma.service';

const ROOT = resolve(__dirname, '../../..');

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const target = printDbBanner('npm run catalog:export (из базы только чтение)');
  const file = resolve(argValue('--file') ?? join(ROOT, 'docs/content/VITALO_catalog.xlsx'));
  const out = resolve(argValue('--out') ?? file);
  const prisma = new PrismaService();
  try {
    const db = await loadCatalogDb(prisma);
    if (out === file) copyFileSync(file, file.replace(/\.xlsx$/i, '.before-export.xlsx'));
    const date = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent' });
    const s = await writeCatalogWorkbook(file, out, db, `${date}, база ${target.database}`);
    console.log(`Готово: ${out}`);
    console.log(`Товаров: ${s.products}${s.productsAdded.length ? ` (новые строки: ${s.productsAdded.join(', ')})` : ''}; веществ: ${s.substances}; правил: ${s.rules}.`);
    if (s.brandsAdded.length) console.log(`Добавлены бренды: ${s.brandsAdded.join(', ')}`);
    if (s.categoriesAdded.length) console.log(`Добавлены категории: ${s.categoriesAdded.join(', ')}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
