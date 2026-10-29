/**
 * Stage 2.2: moving products to the three-layer catalog (see src/catalog/stage22-transfer.ts).
 *
 *   npm run catalog:stage22                              -> check only: two tables + brands to merge, writes nothing
 *   npm run catalog:stage22 -- --out plan.md             -> the same, also saved to a file
 *   npm run catalog:stage22 -- --set-type OZN-A012=minerals   -> a product's type set by hand (repeatable)
 *   npm run catalog:stage22 -- --apply                   -> backup tables, then the move (one transaction)
 *   npm run catalog:stage22 -- --rollback                -> everything back from the backup tables
 *
 * Only *_dev / *_test databases; the shop's database needs --allow-production and its name typed in.
 * Run after the migration 20261030200000_stage22_catalog_brands.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { assertDataScriptTarget } from '../src/common/db-target';
import { similarBrandGroups } from '../src/catalog/brand-names';
import { applyTransfer, formatPlan, planTransfer, rollbackTransfer, TYPE_TARGETS } from '../src/catalog/stage22-transfer';
import { PrismaService } from '../src/prisma/prisma.service';

function argValues(flag: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => a === flag && process.argv[i + 1] && out.push(process.argv[i + 1]));
  return out;
}

async function main() {
  await assertDataScriptTarget('npm run catalog:stage22');
  const prisma = new PrismaService();
  try {
    if (process.argv.includes('--rollback')) {
      const r = await rollbackTransfer(prisma);
      console.log(`ОТКАТ выполнен: связей товаров восстановлено ${r.links}, категорий — ${r.categories}.`);
      return;
    }
    const overrides: Record<string, string> = {};
    for (const v of argValues('--set-type')) {
      const [sku, slug] = v.split('=');
      if (!sku || !TYPE_TARGETS.some((t) => t.slug === slug)) throw new Error(`--set-type ${v}: нужно SKU=тип, тип — один из ${TYPE_TARGETS.map((t) => t.slug).join(', ')}`);
      overrides[sku] = slug;
    }
    const plan = await planTransfer(prisma, overrides);
    const brands = await prisma.brands.findMany({ orderBy: { name_ru: 'asc' }, include: { _count: { select: { products: true } } } });
    const groups = similarBrandGroups(brands);
    const brandText = [
      `### Бренды (${brands.length})\n`,
      groups.length
        ? 'Похоже на один бренд, написанный по-разному (сами не объединяются):\n\n' +
          groups.map((g) => '- ' + g.map((b) => `«${b.name_ru}» (товаров: ${b._count.products})`).join(' и ')).join('\n')
        : 'Похожих названий не найдено.',
      '',
      brands.map((b) => `${b.name_ru} — ${b._count.products}`).join('; '),
    ].join('\n');
    const text = formatPlan(plan) + '\n\n' + brandText + '\n';

    const out = argValues('--out')[0];
    if (out) writeFileSync(out, text);
    if (!process.argv.includes('--apply')) {
      console.log('ПРОВЕРКА: в базу ничего не записывается\n');
      console.log(text);
      console.log('Чтобы применить: npm run catalog:stage22 -- --apply');
      return;
    }
    const r = await applyTransfer(prisma, plan);
    console.log(
      `ПЕРЕНОС выполнен: добавлено связей ${r.linksAdded}, снято лишних типов ${r.typeLinksRemoved}, ` +
        `скрыто категорий ${r.categoriesHidden}, переименовано ${r.categoriesRenamed}. Откат: npm run catalog:stage22 -- --rollback`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
