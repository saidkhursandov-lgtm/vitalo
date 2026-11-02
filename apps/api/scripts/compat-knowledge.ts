/**
 * 3.8: starting knowledge of VITALO AI (D-45) — see src/compat/knowledge-import.ts.
 *
 *   npm run compat:knowledge                         -> check only: tables of what will be added, writes nothing
 *   npm run compat:knowledge -- --out plan.md        -> the same, also saved to a file
 *   npm run compat:knowledge -- --apply              -> adds the rules as drafts and the first substances of products
 *   npm run compat:knowledge -- --apply --update-drafts
 *                                                    -> also rewrites the rules still in draft by the source (new text,
 *                                                       interval) and adds missing substances to filled products
 *
 *   --file <xlsx>   default docs/content/VITALO_catalog.xlsx (sheets «Правила совместимости» and «Товары»)
 *
 * Without --update-drafts nothing existing is changed; nothing is ever deleted, and an approved rule is never touched.
 * Rules work only after an admin approves them («Совместимость → Правила»).
 * Only *_dev / *_test databases; the shop's database needs --allow-production and its name typed in.
 * Run after the migration 20261109100000_stage38_vitalo_ai (it adds the dictionary of substances).
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { assertDataScriptTarget } from '../src/common/db-target';
import { applyKnowledgePlan, buildKnowledgePlan, formatKnowledgePlan, readKnowledgeSheets } from '../src/compat/knowledge-import';
import { PrismaService } from '../src/prisma/prisma.service';

const ROOT = resolve(__dirname, '../../..');

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  await assertDataScriptTarget('npm run compat:knowledge');
  const prisma = new PrismaService();
  try {
    const file = resolve(argValue('--file') ?? join(ROOT, 'docs/content/VITALO_catalog.xlsx'));
    const plan = await buildKnowledgePlan(prisma, await readKnowledgeSheets(file));
    const text = `Файл: ${file}\n\n` + formatKnowledgePlan(plan) + '\n';
    const out = argValue('--out');
    if (out) writeFileSync(out, text);
    if (!process.argv.includes('--apply')) {
      console.log('ПРОВЕРКА: в базу ничего не записывается\n');
      console.log(text);
      console.log('Чтобы добавить: npm run compat:knowledge -- --apply');
      return;
    }
    const r = await applyKnowledgePlan(prisma, plan, { updateDrafts: process.argv.includes('--update-drafts') });
    console.log(
      `ДОБАВЛЕНО: веществ ${r.substances}, правил-черновиков ${r.rules}, товаров с веществами ${r.products}; ` +
        `обновлено черновиков ${r.updated}, добавлено связок товар-вещество ${r.added}. Одобрить правила: админка → Совместимость → Правила.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
