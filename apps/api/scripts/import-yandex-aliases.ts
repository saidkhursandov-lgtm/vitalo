/**
 * Alternative SKUs (old codes) from VITALO_SKU_для_Яндекса.xlsx, sheet «SKU для Яндекса» (A — SKU, D — «Прежний SKU
 * у нас», E — «Старый SKU в Яндексе»).
 *
 *   npm run import:yandex-aliases                     -> check only (dry run), writes nothing
 *   npm run import:yandex-aliases -- --confirm        -> writes (all or nothing)
 *   npm run import:yandex-aliases -- <file.xlsx>      -> another file (or --file <path>)
 *
 * Only *_dev / *_test databases; any other needs --allow-production and the database name typed in.
 * See src/import/sku-aliases-import.ts.
 */
import 'dotenv/config';
import { resolve } from 'path';
import { assertDataScriptTarget } from '../src/common/db-target';
import { applySkuAliases, formatAliasesPlan, planSkuAliases } from '../src/import/sku-aliases-import';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/staff/audit.service';

const ROOT = resolve(__dirname, '..', '..', '..');

function fileArg(): string {
  const i = process.argv.indexOf('--file');
  if (i > 0 && process.argv[i + 1]) return resolve(process.argv[i + 1]);
  const args = process.argv.slice(2);
  const positional = args.find((a, k) => !a.startsWith('--') && args[k - 1] !== '--file');
  return positional ? resolve(positional) : resolve(ROOT, 'VITALO_SKU_для_Яндекса.xlsx');
}

async function main() {
  await assertDataScriptTarget('npm run import:yandex-aliases');
  const confirm = process.argv.includes('--confirm');
  const file = fileArg();
  const prisma = new PrismaService();
  try {
    const plan = await planSkuAliases(prisma, file);
    console.log(confirm ? 'ЗАПИСЬ\n' : 'ПРОВЕРКА (--dry-run): в базу ничего не записывается\n');
    console.log(`Файл: ${file}\n`);
    console.log(formatAliasesPlan(plan));
    if (plan.errors.length) {
      process.exitCode = 1;
      if (confirm) console.log('\nЕсть ошибки — ничего не записано.');
      return;
    }
    if (!confirm) {
      if (plan.create.length) console.log('\nЧтобы записать: добавьте --confirm.');
      return;
    }
    const n = await applySkuAliases(prisma, new AuditService(prisma), plan);
    console.log(`\nГОТОВО: создано ${n} альтернативных SKU.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
