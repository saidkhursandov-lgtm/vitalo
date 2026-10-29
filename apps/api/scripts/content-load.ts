/**
 * Content sheet → database: brand texts / order / logos, product short names, needs, type
 * (see src/catalog/content-sheet.ts). Products and brands are never created, renamed or deleted.
 *
 *   npm run content:load                                  -> check only: tables of what will change, writes nothing
 *   npm run content:load -- --out plan.md                 -> the same, also saved to a file
 *   npm run content:load -- --skip VM-DUO-120             -> a sheet row left out (repeatable)
 *   npm run content:load -- --map VM-DUO-120=OZN-A004     -> a sheet row tied to a product by hand (repeatable)
 *   npm run content:load -- --apply                       -> backup tables content_backup_<time>_*, then the load
 *   npm run content:load -- --rollback                    -> the latest load undone from its backup
 *
 *   --file <xlsx>   default docs/content/VITALO_content.xlsx
 *   --logos <dir>   default docs/brand/brands (logo files named in the «Бренды» sheet; missing files are skipped)
 *
 * Only *_dev / *_test databases; the shop's database needs --allow-production and its name typed in.
 * Run after the migration 20261030300000_product_short_names.
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { assertDataScriptTarget } from '../src/common/db-target';
import { applyContent, buildContentPlan, formatContentPlan, loadDbForContent, readContentSheet, rollbackContent, SheetBrand } from '../src/catalog/content-sheet';
import { PrismaService } from '../src/prisma/prisma.service';
import { storeBrandLogo } from '../src/staff/admin-brands';
import { LocalFileStorage } from '../src/storage/file-storage';

const ROOT = resolve(__dirname, '../../..');

function argValues(flag: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => a === flag && process.argv[i + 1] && out.push(process.argv[i + 1]));
  return out;
}

async function main() {
  await assertDataScriptTarget('npm run content:load');
  const prisma = new PrismaService();
  try {
    if (process.argv.includes('--rollback')) {
      const r = await rollbackContent(prisma);
      console.log(`ОТКАТ выполнен (копия ${r.backup}): связей восстановлено ${r.links}, брендов ${r.brands}, товаров ${r.products}.`);
      return;
    }
    const file = resolve(argValues('--file')[0] ?? join(ROOT, 'docs/content/VITALO_content.xlsx'));
    const logoDir = resolve(argValues('--logos')[0] ?? join(ROOT, 'docs/brand/brands'));
    const map: Record<string, string> = {};
    for (const v of argValues('--map')) {
      const [from, to] = v.split('=');
      if (!from || !to) throw new Error(`--map ${v}: нужно АРТИКУЛ_В_ФАЙЛЕ=АРТИКУЛ_В_БАЗЕ`);
      map[from] = to;
    }

    const sheet = await readContentSheet(file);
    const db = await loadDbForContent(prisma);
    const plan = buildContentPlan(sheet, db, { skip: argValues('--skip'), map });
    const logoPath = (b: SheetBrand) => (b.logo ? join(logoDir, b.logo) : null);
    const logoNote = (b: SheetBrand) => {
      const p = logoPath(b);
      return !p ? '—' : existsSync(p) ? b.logo! : `нет файла ${b.logo}`;
    };
    const text = `Файл: ${file}\n\n` + formatContentPlan(plan, db.categories, logoNote) + '\n';

    const out = argValues('--out')[0];
    if (out) writeFileSync(out, text);
    if (!process.argv.includes('--apply')) {
      console.log('ПРОВЕРКА: в базу ничего не записывается\n');
      console.log(text);
      console.log('Чтобы загрузить: npm run content:load -- --apply (с теми же --skip / --map)');
      return;
    }

    // Logo files are saved before the transaction; a failed load leaves only unused files behind.
    const storage = new LocalFileStorage(new ConfigService());
    const logoUrls = new Map<string, string>();
    for (const { brand, sheet: b } of plan.brands) {
      const p = logoPath(b);
      if (!p || !existsSync(p)) continue;
      const stored = await storeBrandLogo(storage, brand.id, readFileSync(p));
      if (!stored.square) console.log(`Внимание: логотип ${b.logo} не квадратный (${stored.width}×${stored.height}), вписан в квадрат`);
      logoUrls.set(brand.id, stored.url);
    }
    const r = await applyContent(prisma, plan, logoUrls);
    console.log(
      `ЗАГРУЖЕНО: брендов ${r.brands} (логотипов ${r.logos}), товаров ${r.products}; потребностей добавлено ${r.needsAdded}, ` +
        `убрано ${r.needsRemoved}; типов изменено ${r.typesChanged}. Резервная копия: ${r.backup}. Откат: npm run content:load -- --rollback`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
