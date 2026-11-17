/**
 * 14.11.2026: forms of substances and the labels «Форма вещества» (owner's decisions, src/compat/forms-plan.ts).
 *
 *   npm run compat:forms                       -> check only: what will be added and changed, writes nothing
 *   npm run compat:forms -- --out plan.md      -> the same, also saved to a file
 *   npm run compat:forms -- --apply            -> backup tables forms_backup_<time>_*, then the load (one transaction)
 *   npm run compat:forms -- --rollback         -> the latest load undone from its backup
 *
 * Safe to repeat: existing substances and products already done are skipped. Nothing is deleted: a substance made here
 * is switched off by --rollback. Only *_dev / *_test databases; the shop's database needs --allow-production and its
 * name typed in. Run after the migration 20261203100000_substance_label.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { assertDataScriptTarget } from '../src/common/db-target';
import { applyFormsPlan, buildFormsPlan, formatFormsPlan, rollbackFormsPlan } from '../src/compat/forms-load';
import { PrismaService } from '../src/prisma/prisma.service';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  await assertDataScriptTarget('npm run compat:forms');
  const prisma = new PrismaService();
  try {
    if (process.argv.includes('--rollback')) {
      const r = await rollbackFormsPlan(prisma);
      console.log(`ОТКАТ выполнен (копия ${r.backup}): товаров ${r.products}, выключено новых записей справочника ${r.switchedOff}.`);
      return;
    }
    const plan = await buildFormsPlan(prisma);
    const text = formatFormsPlan(plan) + '\n';
    const out = argValue('--out');
    if (out) writeFileSync(out, text);
    if (!process.argv.includes('--apply')) {
      console.log('ПРОВЕРКА: в базу ничего не записывается\n');
      console.log(text);
      console.log('Чтобы загрузить: npm run compat:forms -- --apply');
      return;
    }
    const r = await applyFormsPlan(prisma, plan);
    console.log(
      `ЗАГРУЖЕНО: новых записей справочника ${r.created}, веществ с новыми написаниями ${r.synonyms}, товаров ${r.products}. Резервная копия: ${r.backup}. Откат: npm run compat:forms -- --rollback`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
