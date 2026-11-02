/**
 * Dev/test seed: 3 regions x 2 cities, two category trees, 1 warehouse, 10 supplements with stock.
 * Safe to re-run: it only CREATES what is missing (stable ids) and never overwrites existing rows,
 * so admin edits, stock and reservations of real orders are left alone.
 * Run: npm run seed
 */
// .env first: on the server it says NODE_ENV=production, and then this demo seed refuses to run.
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma, PrismaClient, TreeType } from '@prisma/client';
import { assertDevOrTestDatabase } from '../src/common/db-target';
import { SETTING_DEFAULTS } from '../src/settings/settings.service';
import { BANK_TRANSFER_DETAILS, CATEGORIES, PAYMENT_METHODS, uid, type CategorySeed } from './reference-data';

// Demo products, test employees and 3 extra regions must never reach the real shop: only vitalo_dev / vitalo_test
// (any *_dev / *_test database), never NODE_ENV=production. Checked before any connection is made.
assertDevOrTestDatabase('prisma/seed.ts (DEMO seed)');

const prisma = new PrismaClient();

const REGIONS = [
  { key: 'tashkent-city', ru: 'г. Ташкент', uz: 'Toshkent shahri', cities: [['Юнусабадский район', 'Yunusobod tumani'], ['Чиланзарский район', 'Chilonzor tumani']] },
  { key: 'samarkand', ru: 'Самаркандская область', uz: 'Samarqand viloyati', cities: [['Самарканд', 'Samarqand'], ['Каттакурган', 'Kattaqo‘rg‘on']] },
  { key: 'fergana', ru: 'Ферганская область', uz: 'Farg‘ona viloyati', cities: [['Фергана', 'Farg‘ona'], ['Коканд', 'Qo‘qon']] },
];



interface ProductSeed {
  sku: string; ru: string; uz: string; brand: string; manufacturer: string; country: string; form: string;
  price: number; old?: number; popularity: number; stock: number; reserved?: number;
  categories: string[]; keywords: string; description: string; directions: string;
}

// Fictional brands. Created_at grows with the index, so the last product is the newest.
const PRODUCTS: ProductSeed[] = [
  { sku: 'VTL-D3-2000', ru: 'Витамин D3 2000 МЕ, 60 капсул', uz: 'Vitamin D3 2000 IU, 60 kapsula', brand: 'SunVita', manufacturer: 'SunVita Labs', country: 'США', form: 'Капсулы',
    price: 89_000, popularity: 120, stock: 50, reserved: 2, categories: ['vitamins', 'immunity', 'joints'],
    keywords: 'холекальциферол cholecalciferol', description: 'Поддержка иммунитета и здоровья костей.', directions: '1 капсула в день во время еды.' },
  { sku: 'VTL-C-1000', ru: 'Витамин С 1000 мг, 60 таблеток', uz: 'Vitamin C 1000 mg, 60 tabletka', brand: 'SunVita', manufacturer: 'SunVita Labs', country: 'США', form: 'Таблетки',
    price: 65_000, old: 79_000, popularity: 95, stock: 40, reserved: 5, categories: ['vitamins', 'immunity'],
    keywords: 'аскорбиновая кислота ascorbic acid', description: 'Антиоксидант, поддержка иммунитета.', directions: '1 таблетка в день.' },
  { sku: 'VTL-OMEGA3', ru: 'Омега-3 1000 мг, 90 капсул', uz: 'Omega-3 1000 mg, 90 kapsula', brand: 'NordOcean', manufacturer: 'NordOcean AS', country: 'Норвегия', form: 'Капсулы',
    price: 145_000, popularity: 150, stock: 30, categories: ['omega', 'energy'],
    keywords: 'рыбий жир fish oil epa dha', description: 'Жирные кислоты для сердца и сосудов.', directions: '2 капсулы в день во время еды.' },
  { sku: 'VTL-COLLAGEN', ru: 'Коллаген морской с витамином C, порошок 150 г', uz: 'Dengiz kollageni C vitamini bilan, kukun 150 g', brand: 'BeautyLab', manufacturer: 'BeautyLab Co', country: 'Корея', form: 'Порошок',
    price: 210_000, old: 240_000, popularity: 80, stock: 20, categories: ['collagen', 'beauty', 'joints'],
    keywords: 'marine collagen пептиды peptides', description: 'Для упругости кожи и здоровья суставов.', directions: '1 мерная ложка в стакане воды.' },
  { sku: 'VTL-MG-B6', ru: 'Магний B6, 60 таблеток', uz: 'Magniy B6, 60 tabletka', brand: 'SunVita', manufacturer: 'SunVita Labs', country: 'США', form: 'Таблетки',
    price: 72_000, popularity: 110, stock: 60, categories: ['minerals', 'sleep', 'energy'],
    keywords: 'magnesium пиридоксин', description: 'Снижает усталость, поддерживает нервную систему.', directions: '2 таблетки в день.' },
  { sku: 'VTL-ZINC-25', ru: 'Цинк хелат 25 мг, 60 таблеток', uz: 'Rux xelat 25 mg, 60 tabletka', brand: 'PureMin', manufacturer: 'PureMin GmbH', country: 'Германия', form: 'Таблетки',
    price: 54_000, popularity: 40, stock: 0, categories: ['minerals', 'immunity', 'beauty'],
    keywords: 'zinc chelate бисглицинат', description: 'Для иммунитета, кожи и волос.', directions: '1 таблетка в день.' },
  { sku: 'VTL-PROBIO', ru: 'Пробиотик комплекс, 10 штаммов, 30 капсул', uz: 'Probiotik kompleks, 10 shtamm, 30 kapsula', brand: 'BioFlora', manufacturer: 'BioFlora Ltd', country: 'Великобритания', form: 'Капсулы',
    price: 168_000, popularity: 30, stock: 15, categories: ['other', 'immunity'],
    keywords: 'probiotic лактобактерии бифидобактерии', description: 'Поддержка микрофлоры кишечника.', directions: '1 капсула утром натощак.' },
  { sku: 'VTL-MELATONIN', ru: 'Мелатонин 3 мг, 60 таблеток', uz: 'Melatonin 3 mg, 60 tabletka', brand: 'NightCalm', manufacturer: 'NightCalm Inc', country: 'США', form: 'Таблетки',
    price: 98_000, popularity: 70, stock: 25, categories: ['other', 'sleep'],
    keywords: 'melatonin сон sleep', description: 'Помогает быстрее заснуть.', directions: '1 таблетка за 30 минут до сна.' },
  { sku: 'VTL-K2-MK7', ru: 'Витамин K2 MK-7 100 мкг, 60 капсул', uz: 'Vitamin K2 MK-7 100 mkg, 60 kapsula', brand: 'SunVita', manufacturer: 'SunVita Labs', country: 'США', form: 'Капсулы',
    price: 115_000, popularity: 25, stock: 25, reserved: 1, categories: ['vitamins', 'joints'],
    keywords: 'менахинон menaquinone', description: 'Направляет кальций в кости.', directions: '1 капсула в день.' },
  { sku: 'VTL-BIOTIN', ru: 'Биотин 5000 мкг, 60 капсул', uz: 'Biotin 5000 mkg, 60 kapsula', brand: 'BeautyLab', manufacturer: 'BeautyLab Co', country: 'Корея', form: 'Капсулы',
    price: 76_000, popularity: 60, stock: 35, categories: ['vitamins', 'beauty'],
    keywords: 'biotin витамин B7', description: 'Для крепких волос и ногтей.', directions: '1 капсула в день.' },
];

const RELATIONS: [string, string, 'similar' | 'also_bought'][] = [
  ['VTL-D3-2000', 'VTL-K2-MK7', 'similar'],
  ['VTL-K2-MK7', 'VTL-D3-2000', 'similar'],
  ['VTL-C-1000', 'VTL-ZINC-25', 'similar'],
  ['VTL-ZINC-25', 'VTL-C-1000', 'similar'],
  ['VTL-COLLAGEN', 'VTL-BIOTIN', 'also_bought'],
];

const WAREHOUSE_ID = uid('warehouse:main');
const BASE_DATE = Date.UTC(2026, 8, 1); // 2026-09-01

// Delivery tariffs (UZS): region default + one city override. Threshold = free shipping from this amount.
const TARIFFS: { region: string; city?: string; tariff: number; threshold: number }[] = [
  { region: 'tashkent-city', tariff: 20_000, threshold: 300_000 },
  { region: 'samarkand', tariff: 35_000, threshold: 500_000 },
  { region: 'samarkand', city: 'Каттакурган', tariff: 45_000, threshold: 500_000 },
  { region: 'fergana', tariff: 35_000, threshold: 500_000 },
];



// Dev staff, one per role (fake Telegram ids, also used by e2e tests). The admin panel dev login offers them.
const DEV_STAFF = [
  { telegram_user_id: 222_222_221, name: 'Админ (тест)', role: 'admin' as const },
  { telegram_user_id: 222_222_222, name: 'Менеджер (тест)', role: 'manager' as const },
  { telegram_user_id: 222_222_223, name: 'Склад (тест)', role: 'warehouse' as const },
  { telegram_user_id: 222_222_224, name: 'Маркетолог (тест)', role: 'marketer' as const },
];

async function seedCheckoutSettings() {
  for (const m of PAYMENT_METHODS) {
    await prisma.payment_methods.upsert({ where: { code: m.code }, create: m, update: {} });
  }
  // 2.1: the two built-in home banners (same ids as in the migration); never changed if they exist
  for (const [id, kind, sort_order] of [
    ['00000000-0000-4000-8000-00000000b001', 'doctor', 1],
    ['00000000-0000-4000-8000-00000000b002', 'delivery', 2],
  ] as const) {
    await prisma.home_banners.upsert({ where: { id }, create: { id, kind, sort_order }, update: {} });
  }
  const settings = { bank_transfer_details: BANK_TRANSFER_DETAILS, ...SETTING_DEFAULTS } as unknown as Record<string, Prisma.InputJsonValue>;
  for (const [key, value] of Object.entries(settings)) {
    await prisma.settings.upsert({ where: { key }, create: { key, value }, update: {} });
  }
  for (const t of TARIFFS) {
    const id = uid(`tariff:${t.region}:${t.city ?? '*'}`);
    const data = {
      region_id: uid(`region:${t.region}`),
      city_id: t.city ? uid(`city:${t.region}:${t.city}`) : null,
      tariff_uzs: BigInt(t.tariff),
      free_shipping_threshold_uzs: BigInt(t.threshold),
      status: 'active' as const,
      // delivery term, working days: Tashkent city 2-5, regions 5-10 (city tariffs take the region one)
      ...(!t.city && { min_days: t.region === 'tashkent-city' ? 2 : 5, max_days: t.region === 'tashkent-city' ? 5 : 10 }),
    };
    await prisma.delivery_tariffs.upsert({ where: { id }, create: { id, ...data }, update: {} });
  }
  for (const s of DEV_STAFF) {
    await prisma.staff_users.upsert({
      where: { telegram_user_id: BigInt(s.telegram_user_id) },
      create: { ...s, telegram_user_id: BigInt(s.telegram_user_id) },
      update: {},
    });
  }
}

async function seedRegions() {
  for (const r of REGIONS) {
    const regionId = uid(`region:${r.key}`);
    await prisma.regions.upsert({
      where: { id: regionId },
      create: { id: regionId, name_ru: r.ru, name_uz: r.uz },
      update: {},
    });
    for (const [ru, uz] of r.cities) {
      const cityId = uid(`city:${r.key}:${ru}`);
      await prisma.cities.upsert({
        where: { id: cityId },
        create: { id: cityId, region_id: regionId, name_ru: ru, name_uz: uz },
        update: {},
      });
    }
  }
}

async function seedCategories() {
  const ids = new Map<string, string>();
  const walk = async (tree: TreeType, list: CategorySeed[], parentId: string | null) => {
    for (const [i, c] of list.entries()) {
      const data = { tree_type: tree, parent_id: parentId, name_ru: c.ru, name_uz: c.uz, sort_order: (i + 1) * 10, status: 'active' as const };
      const row = await prisma.categories.upsert({
        where: { slug: c.slug },
        create: { id: uid(`category:${c.slug}`), slug: c.slug, ...data },
        update: {},
      });
      ids.set(c.slug, row.id);
      if (c.children) await walk(tree, c.children, row.id);
    }
  };
  for (const tree of Object.keys(CATEGORIES) as TreeType[]) await walk(tree, CATEGORIES[tree], null);
  return ids;
}

async function seedProducts(categoryIds: Map<string, string>) {
  await prisma.warehouses.upsert({
    where: { id: WAREHOUSE_ID },
    create: { id: WAREHOUSE_ID, name: 'Основной склад', address: 'г. Ташкент' },
    update: {},
  });

  const productIds = new Map<string, string>();
  for (const [i, p] of PRODUCTS.entries()) {
    // Never touch an existing product: its price/texts may be edited in the admin panel and its stock
    // belongs to real orders (re-seeding once reset reservations — see git history).
    const existing = await prisma.products.findUnique({ where: { sku: p.sku } });
    if (existing) {
      productIds.set(p.sku, existing.id);
      continue;
    }
    const data = {
      name_ru: p.ru, name_uz: p.uz, brand: p.brand, manufacturer: p.manufacturer, country: p.country, form: p.form,
      price_uzs: BigInt(p.price), old_price_uzs: p.old ? BigInt(p.old) : null,
      status: 'active' as const, popularity_30d: p.popularity, search_keywords: p.keywords, min_stock: 10,
      short_description_ru: p.description, directions_ru: p.directions,
      warnings_ru: 'Не является лекарственным средством. Перед применением проконсультируйтесь с врачом.',
      created_at: new Date(BASE_DATE + i * 86_400_000),
    };
    const product = await prisma.products.create({ data: { id: uid(`product:${p.sku}`), sku: p.sku, ...data } });
    productIds.set(p.sku, product.id);

    await prisma.product_categories.createMany({
      data: p.categories.map((slug) => ({ product_id: product.id, category_id: categoryIds.get(slug)! })),
    });
    await prisma.product_media.create({
      data: { product_id: product.id, media_type: 'image', is_main: true, url: `https://placehold.co/600x600/png?text=${encodeURIComponent(p.sku)}` },
    });
    await prisma.inventory.create({
      data: { product_id: product.id, warehouse_id: WAREHOUSE_ID, actual_qty: p.stock, reserved_qty: p.reserved ?? 0 },
    });
    if (p.stock > 0) {
      await prisma.inventory_batches.create({
        data: { product_id: product.id, warehouse_id: WAREHOUSE_ID, batch_no: `SEED-${p.sku}`, qty: p.stock, expiry_date: new Date('2028-06-30') },
      });
      await prisma.inventory_movements.create({
        data: { product_id: product.id, warehouse_id: WAREHOUSE_ID, movement_type: 'receipt', qty: p.stock, reason: 'seed' },
      });
    }
  }

  for (const [from, to, type] of RELATIONS) {
    const product_id = productIds.get(from)!;
    const related_product_id = productIds.get(to)!;
    await prisma.product_relations.upsert({
      where: { product_id_related_product_id_relation_type: { product_id, related_product_id, relation_type: type } },
      create: { product_id, related_product_id, relation_type: type },
      update: {},
    });
  }
}

/**
 * 3.8: the starting dictionary of substances — the same SQL as in the migration (from its «starting dictionary» line
 * to the end), so the list lives in one place. ON CONFLICT DO NOTHING: an edit is never overwritten.
 */
async function seedSubstances() {
  const sql = readFileSync(join(__dirname, 'migrations/20261109100000_stage38_vitalo_ai/migration.sql'), 'utf8');
  const part = sql.slice(sql.indexOf('-- The starting dictionary'));
  for (const statement of part.split(/;s*$/m).map((x) => x.replace(/^s*--.*$/gm, '').trim()).filter(Boolean)) {
    await prisma.$executeRawUnsafe(statement);
  }
}

async function main() {
  await seedRegions();
  const categoryIds = await seedCategories();
  await seedProducts(categoryIds);
  await seedCheckoutSettings();
  await seedSubstances();
  console.log(
    `Seed done: ${REGIONS.length} regions, ${categoryIds.size} categories, ${PRODUCTS.length} products, ` +
      `${TARIFFS.length} tariffs, ${PAYMENT_METHODS.length} payment methods, ${DEV_STAFF.length} dev staff.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
