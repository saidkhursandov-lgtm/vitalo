/**
 * Optimizes product photos uploaded before block D (DATABASE_URL and UPLOAD_DIR from apps/api/.env):
 * main WebP up to 1200 px + 400 px thumbnail, JPEG fallbacks; the original file is removed afterwards.
 *
 *   npm run photos:optimize               -> check only (dry run), changes nothing
 *   npm run photos:optimize -- --confirm  -> really converts
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { LocalFileStorage, uploadDir } from '../src/storage/file-storage';
import { applyPhotoOptimization, planPhotoOptimization } from '../src/storage/optimize-existing';

const kb = (n: number) => `${Math.round(n / 1024)} КБ`;

async function main() {
  const confirm = process.argv.includes('--confirm');
  const config = new ConfigService();
  const dir = uploadDir(config);
  const prisma = new PrismaService();
  try {
    const db = new URL(process.env.DATABASE_URL ?? 'postgresql://x/unknown').pathname.slice(1);
    const plan = await planPhotoOptimization(prisma, dir);
    console.log(`${confirm ? 'ОПТИМИЗАЦИЯ' : 'ПРОВЕРКА (--dry-run): ничего не меняется'}\nБаза: ${db}\nПапка фото: ${dir}\n`);
    for (const r of plan) console.log(`${r.action === 'optimize' ? 'СЖАТЬ   ' : 'ПРОПУСК '} ${r.sku}  ${r.url}${r.bytes ? `  (${kb(r.bytes)})` : ''}${r.reason ? `  — ${r.reason}` : ''}`);
    const todo = plan.filter((r) => r.action === 'optimize').length;
    console.log(`\nИтого: сжать ${todo}, пропустить ${plan.length - todo}.`);
    if (!confirm) {
      if (todo) console.log('Чтобы выполнить: npm run photos:optimize -- --confirm');
      return;
    }
    const res = await applyPhotoOptimization(prisma, new LocalFileStorage(config), dir, plan);
    for (const d of res.done) console.log(`ГОТОВО ${d.sku}: ${kb(d.before)} -> ${kb(d.after)} (основное + миниатюра WebP)`);
    for (const f of res.failed) console.log(`ОШИБКА ${f.sku} ${f.url}: ${f.error}`);
    if (res.failed.length) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
