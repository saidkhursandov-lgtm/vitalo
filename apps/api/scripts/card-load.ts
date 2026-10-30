/**
 * 2.3: product card content (sheet «Товары», columns J–Z) → database (see src/catalog/card-content.ts).
 * Only the card fields; needs, types, prices and stock are not touched. Products are never created or deleted.
 *
 *   npm run content:card                              -> check only: tables of what will change, writes nothing
 *   npm run content:card -- --out plan.md             -> the same, also saved to a file
 *   npm run content:card -- --skip VM-DUO-120         -> a sheet row left out (repeatable)
 *   npm run content:card -- --map OV-VD3-60=OZN-A003  -> a sheet row tied to a product by hand (repeatable)
 *   npm run content:card -- --apply                   -> backup tables card_backup_<time>_*, then the load
 *   npm run content:card -- --rollback                -> the latest load undone from its backup
 *
 *   --file <xlsx>   default docs/content/VITALO_content.xlsx
 *
 * Only *_dev / *_test databases; the shop's database needs --allow-production and its name typed in.
 * Run after the migration 20261030400000_stage23_product_card.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { assertDataScriptTarget } from '../src/common/db-target';
import { applyCardContent, buildCardPlan, formatCardPlan, rollbackCardContent } from '../src/catalog/card-content';
import { loadDbForContent, readContentSheet } from '../src/catalog/content-sheet';
import { PrismaService } from '../src/prisma/prisma.service';

const ROOT = resolve(__dirname, '../../..');

function argValues(flag: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => a === flag && process.argv[i + 1] && out.push(process.argv[i + 1]));
  return out;
}

async function main() {
  await assertDataScriptTarget('npm run content:card');
  const prisma = new PrismaService();
  try {
    if (process.argv.includes('--rollback')) {
      const r = await rollbackCardContent(prisma);
      console.log(`ОТКАТ выполнен (копия ${r.backup}): товаров ${r.products}, брендов ${r.brands}.`);
      return;
    }
    const file = resolve(argValues('--file')[0] ?? join(ROOT, 'docs/content/VITALO_content.xlsx'));
    const map: Record<string, string> = {};
    for (const v of argValues('--map')) {
      const [from, to] = v.split('=');
      if (!from || !to) throw new Error(`--map ${v}: нужно АРТИКУЛ_В_ФАЙЛЕ=АРТИКУЛ_В_БАЗЕ`);
      map[from] = to;
    }
    const plan = buildCardPlan(await readContentSheet(file), await loadDbForContent(prisma), { skip: argValues('--skip'), map });
    const text = `Файл: ${file}\n\n` + formatCardPlan(plan) + '\n';
    const out = argValues('--out')[0];
    if (out) writeFileSync(out, text);
    if (!process.argv.includes('--apply')) {
      console.log('ПРОВЕРКА: в базу ничего не записывается\n');
      console.log(text);
      console.log('Чтобы загрузить: npm run content:card -- --apply (с теми же --skip / --map)');
      return;
    }
    const r = await applyCardContent(prisma, plan);
    console.log(`ЗАГРУЖЕНО: карточек товаров ${r.products}, брендов ${r.brands}. Резервная копия: ${r.backup}. Откат: npm run content:card -- --rollback`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
