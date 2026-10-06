/**
 * First start of the real shop (after `npx prisma migrate deploy`):
 *   npm run bootstrap:prod
 * Creates only missing reference data (categories, payment methods, settings, Tashkent warehouse).
 * Never creates products, customers or employees; safe to run again. See prisma/bootstrap.ts.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { printDbBanner } from '../src/common/db-target';
import { bootstrapReferenceData } from '../prisma/bootstrap';

async function main() {
  printDbBanner('npm run bootstrap:prod');
  const prisma = new PrismaClient();
  try {
    const db = new URL(process.env.DATABASE_URL ?? 'postgresql://x/unknown').pathname.slice(1);
    const created = await bootstrapReferenceData(prisma);
    const counts = {
      regions: await prisma.regions.count(),
      cities: await prisma.cities.count(),
      tariffs: await prisma.delivery_tariffs.count({ where: { status: 'active' } }),
      categories: await prisma.categories.count(),
      products: await prisma.products.count(),
      staff: await prisma.staff_users.count(),
    };
    console.log(`База: ${db}`);
    console.log(`Добавлено сейчас: категорий ${created.categories}, способов оплаты ${created.payment_methods}, настроек ${created.settings}, складов ${created.warehouses}.`);
    console.log(`Всего в базе: регионов ${counts.regions}, городов ${counts.cities}, активных тарифов ${counts.tariffs}, категорий ${counts.categories}, товаров ${counts.products}, сотрудников ${counts.staff}.`);
    if (!counts.staff) console.log('Сотрудников ещё нет: добавьте администратора командой npm run staff:add -- --telegram-id <ID> --name "<Имя>" --role admin');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
