/**
 * Loads products from the Excel template into the database set in DATABASE_URL (apps/api/.env).
 *
 *   npm run import:products                      -> check only (dry run), writes nothing
 *   npm run import:products -- --confirm         -> really writes (products, photos, stock)
 *   options: --file <path to .xlsx>   (default: VITALO_товары.xlsx in the project root)
 *            --photos <folder>        (default: photos/ in the project root)
 *
 * Not a seed: touches only the products listed in the file. See src/import/product-import.ts.
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'path';
import { applyImport, formatPlan, formatResult, planImport } from '../src/import/product-import';
import { PrismaService } from '../src/prisma/prisma.service';
import { AdminInventoryService } from '../src/staff/admin-inventory';
import { AdminProductsService } from '../src/staff/admin-products';
import { AuditService } from '../src/staff/audit.service';
import { LocalFileStorage } from '../src/storage/file-storage';

const ROOT = resolve(__dirname, '..', '..', '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const file = resolve(arg('file') ?? resolve(ROOT, 'VITALO_товары.xlsx'));
  const photosDir = resolve(arg('photos') ?? resolve(ROOT, 'photos'));

  const prisma = new PrismaService();
  try {
    const plan = await planImport(prisma, { file, photosDir });
    console.log(confirm ? 'РЕАЛЬНАЯ ЗАГРУЗКА\n' : 'ПРОВЕРКА (--dry-run): в базу ничего не записывается\n');
    console.log(`Файл: ${file}\nФото: ${photosDir}`);
    console.log(formatPlan(plan));
    if (!confirm) {
      console.log('\nЧтобы записать: npm run import:products -- --confirm');
      if (plan.errors.length) process.exitCode = 1;
      return;
    }
    if (plan.errors.length) {
      console.error('\nЗагрузка отменена: сначала исправьте ошибки в таблице.');
      process.exitCode = 1;
      return;
    }
    const audit = new AuditService(prisma);
    const result = await applyImport(plan, {
      prisma,
      products: new AdminProductsService(prisma, audit, new LocalFileStorage(new ConfigService())),
      inventory: new AdminInventoryService(prisma, audit),
    });
    console.log('\nГОТОВО\n' + formatResult(result));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
