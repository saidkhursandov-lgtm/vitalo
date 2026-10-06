/**
 * Stage 1.5: Yandex Market table -> products (Yandex price, commission, payment fee, logistics; empty texts;
 * dictionaries; new SKUs as hidden products).
 *
 *   npm run import:yandex                        -> check only (dry run), writes nothing
 *   npm run import:yandex -- --confirm           -> writes (all or nothing)
 *   options: --file <path to .xlsx>  (default: VITALO_Yandex_данные_v4.xlsx in the project root)
 *
 * Only *_dev / *_test databases; any other needs --allow-production and the database name typed in.
 * See src/import/yandex-import.ts.
 */
import 'dotenv/config';
import { resolve } from 'path';
import { assertDataScriptTarget } from '../src/common/db-target';
import { applyYandexImport, formatYandexPlan, formatYandexResult, planYandexImport } from '../src/import/yandex-import';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/staff/audit.service';

const ROOT = resolve(__dirname, '..', '..', '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  await assertDataScriptTarget('npm run import:yandex');
  const confirm = process.argv.includes('--confirm');
  const file = resolve(arg('file') ?? resolve(ROOT, 'VITALO_Yandex_данные_v4.xlsx'));
  const prisma = new PrismaService();
  try {
    const plan = await planYandexImport(prisma, file);
    console.log(confirm ? 'ЗАПИСЬ\n' : 'ПРОВЕРКА (--dry-run): в базу ничего не записывается\n');
    console.log(`Файл: ${file}\n`);
    console.log(formatYandexPlan(plan));
    if (!confirm) {
      if (!plan.errors.length) console.log('\nЧтобы записать: npm run import:yandex -- --confirm');
      return;
    }
    console.log('\n' + formatYandexResult(await applyYandexImport(prisma, new AuditService(prisma), plan)));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
