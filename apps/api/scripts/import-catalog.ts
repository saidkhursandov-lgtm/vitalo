/**
 * The single catalog table -> products (sheet «Товары» of VITALO_каталог_единая_таблица.xlsx).
 *
 *   npm run import:catalog                                -> check only (dry run), writes nothing
 *   npm run import:catalog -- --confirm                   -> writes (all or nothing)
 *   npm run import:catalog -- <file.xlsx>                 -> another file (or --file <path>)
 *   --photos <folder>   photos (default: photos/ in the project root)
 *   --update-text       overwrite texts of existing products (names, descriptions, composition, … , search words)
 *   --apply-prices      overwrite price_uzs and old_price_uzs
 *   --apply-status      overwrite the status (Виден / Скрыт)
 *   --apply-cost        overwrite cost_uzs (without it the cost of existing products is never changed)
 *
 * Only *_dev / *_test databases; any other needs --allow-production and the database name typed in.
 * See src/import/catalog-import.ts.
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'path';
import { assertDataScriptTarget } from '../src/common/db-target';
import { applyCatalogImport, formatCatalogPlan, formatCatalogResult, planCatalogImport } from '../src/import/catalog-import';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/staff/audit.service';
import { LocalFileStorage } from '../src/storage/file-storage';

const ROOT = resolve(__dirname, '..', '..', '..');
const VALUE_FLAGS = ['--file', '--photos'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function fileArg(): string {
  if (arg('file')) return resolve(arg('file')!);
  const args = process.argv.slice(2);
  const positional = args.find((a, k) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[k - 1]));
  return positional ? resolve(positional) : resolve(ROOT, 'VITALO_каталог_единая_таблица.xlsx');
}

async function main() {
  await assertDataScriptTarget('npm run import:catalog');
  const has = (f: string) => process.argv.includes(f);
  const confirm = has('--confirm');
  const file = fileArg();
  const photosDir = resolve(arg('photos') ?? resolve(ROOT, 'photos'));
  const flags = { updateText: has('--update-text'), applyPrices: has('--apply-prices'), applyStatus: has('--apply-status'), applyCost: has('--apply-cost') };
  const prisma = new PrismaService();
  try {
    const plan = await planCatalogImport(prisma, { file, photosDir, flags });
    console.log(confirm ? 'ЗАПИСЬ\n' : 'ПРОВЕРКА (--dry-run): в базу ничего не записывается\n');
    console.log(`Файл: ${file}\nФото: ${photosDir}`);
    console.log(formatCatalogPlan(plan));
    if (!confirm) {
      if (!plan.errors.length) console.log('\nЧтобы записать: добавьте --confirm (с теми же флагами).');
      else process.exitCode = 1;
      return;
    }
    if (plan.errors.length) throw new Error('\nЕсть ошибки — ничего не записано.');
    const audit = new AuditService(prisma);
    console.log('\nГОТОВО\n' + formatCatalogResult(await applyCatalogImport(prisma, audit, new LocalFileStorage(new ConfigService()), plan)));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
