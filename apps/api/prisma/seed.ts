/**
 * Dev/test seed: 3 regions x 2 cities, two category trees, 1 warehouse, 10 supplements with stock.
 * Idempotent: ids are derived from stable keys, so re-running updates rows instead of duplicating them.
 * Run: npm run seed
 */
import { createHash } from 'crypto';
import { PrismaClient, TreeType } from '@prisma/client';

const prisma = new PrismaClient();

/** Deterministic UUID (v5-shaped) from a stable key. */
function uid(key: string): string {
  const h = createHash('sha1').update(`vitalo-seed:${key}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const REGIONS = [
  { key: 'tashkent-city', ru: 'г. Ташкент', uz: 'Toshkent shahri', cities: [['Юнусабадский район', 'Yunusobod tumani'], ['Чиланзарский район', 'Chilonzor tumani']] },
  { key: 'samarkand', ru: 'Самаркандская область', uz: 'Samarqand viloyati', cities: [['Самарканд', 'Samarqand'], ['Каттакурган', 'Kattaqo‘rg‘on']] },
  { key: 'fergana', ru: 'Ферганская область', uz: 'Farg‘ona viloyati', cities: [['Фергана', 'Farg‘ona'], ['Коканд', 'Qo‘qon']] },
];

interface CategorySeed { slug: string; ru: string; uz: string; children?: CategorySeed[] }

const CATEGORIES: Record<TreeType, CategorySeed[]> = {
  need: [
    { slug: 'immunity', ru: 'Иммунитет', uz: 'Immunitet' },
    { slug: 'beauty', ru: 'Красота', uz: 'Go‘zallik', children: [
      { slug: 'beauty-skin', ru: 'Кожа', uz: 'Teri' },
      { slug: 'beauty-hair', ru: 'Волосы и ногти', uz: 'Soch va tirnoqlar' },
    ] },
    { slug: 'joints', ru: 'Суставы и кости', uz: 'Bo‘g‘imlar va suyaklar' },
    { slug: 'energy', ru: 'Энергия', uz: 'Energiya' },
    { slug: 'sleep', ru: 'Сон и стресс', uz: 'Uyqu va stress' },
    { slug: 'heart', ru: 'Сердце и сосуды', uz: 'Yurak va qon tomirlar' },
  ],
  product_type: [
    { slug: 'vitamins', ru: 'Витамины', uz: 'Vitaminlar', children: [
      { slug: 'vitamin-d', ru: 'Витамин D', uz: 'D vitamini' },
      { slug: 'vitamin-c', ru: 'Витамин C', uz: 'C vitamini' },
      { slug: 'vitamin-b', ru: 'Витамины группы B', uz: 'B guruhi vitaminlari' },
      { slug: 'vitamin-k', ru: 'Витамин K', uz: 'K vitamini' },
    ] },
    { slug: 'minerals', ru: 'Минералы', uz: 'Minerallar', children: [
      { slug: 'magnesium', ru: 'Магний', uz: 'Magniy' },
      { slug: 'zinc', ru: 'Цинк', uz: 'Rux' },
    ] },
    { slug: 'omega', ru: 'Омега-3', uz: 'Omega-3' },
    { slug: 'collagen', ru: 'Коллаген', uz: 'Kollagen' },
    { slug: 'probiotics', ru: 'Пробиотики', uz: 'Probiotiklar' },
    { slug: 'other', ru: 'Другие добавки', uz: 'Boshqa qo‘shimchalar' },
  ],
};

interface ProductSeed {
  sku: string; ru: string; uz: string; brand: string; manufacturer: string; country: string; form: string;
  price: number; old?: number; popularity: number; stock: number; reserved?: number;
  categories: string[]; keywords: string; description: string; directions: string;
}

// Fictional brands. Created_at grows with the index, so the last product is the newest.
const PRODUCTS: ProductSeed[] = [
  { sku: 'VTL-D3-2000', ru: 'Витамин D3 2000 МЕ, 60 капсул', uz: 'Vitamin D3 2000 IU, 60 kapsula', brand: 'SunVita', manufacturer: 'SunVita Labs', country: 'США', form: 'Капсулы',
    price: 89_000, popularity: 120, stock: 50, reserved: 2, categories: ['vitamin-d', 'immunity', 'joints'],
    keywords: 'холекальциферол cholecalciferol', description: 'Поддержка иммунитета и здоровья костей.', directions: '1 капсула в день во время еды.' },
  { sku: 'VTL-C-1000', ru: 'Витамин С 1000 мг, 60 таблеток', uz: 'Vitamin C 1000 mg, 60 tabletka', brand: 'SunVita', manufacturer: 'SunVita Labs', country: 'США', form: 'Таблетки',
    price: 65_000, old: 79_000, popularity: 95, stock: 40, reserved: 5, categories: ['vitamin-c', 'immunity'],
    keywords: 'аскорбиновая кислота ascorbic acid', description: 'Антиоксидант, поддержка иммунитета.', directions: '1 таблетка в день.' },
  { sku: 'VTL-OMEGA3', ru: 'Омега-3 1000 мг, 90 капсул', uz: 'Omega-3 1000 mg, 90 kapsula', brand: 'NordOcean', manufacturer: 'NordOcean AS', country: 'Норвегия', form: 'Капсулы',
    price: 145_000, popularity: 150, stock: 30, categories: ['omega', 'heart'],
    keywords: 'рыбий жир fish oil epa dha', description: 'Жирные кислоты для сердца и сосудов.', directions: '2 капсулы в день во время еды.' },
  { sku: 'VTL-COLLAGEN', ru: 'Коллаген морской с витамином C, порошок 150 г', uz: 'Dengiz kollageni C vitamini bilan, kukun 150 g', brand: 'BeautyLab', manufacturer: 'BeautyLab Co', country: 'Корея', form: 'Порошок',
    price: 210_000, old: 240_000, popularity: 80, stock: 20, categories: ['collagen', 'beauty-skin', 'joints'],
    keywords: 'marine collagen пептиды peptides', description: 'Для упругости кожи и здоровья суставов.', directions: '1 мерная ложка в стакане воды.' },
  { sku: 'VTL-MG-B6', ru: 'Магний B6, 60 таблеток', uz: 'Magniy B6, 60 tabletka', brand: 'SunVita', manufacturer: 'SunVita Labs', country: 'США', form: 'Таблетки',
    price: 72_000, popularity: 110, stock: 60, categories: ['magnesium', 'sleep', 'energy'],
    keywords: 'magnesium пиридоксин', description: 'Снижает усталость, поддерживает нервную систему.', directions: '2 таблетки в день.' },
  { sku: 'VTL-ZINC-25', ru: 'Цинк хелат 25 мг, 60 таблеток', uz: 'Rux xelat 25 mg, 60 tabletka', brand: 'PureMin', manufacturer: 'PureMin GmbH', country: 'Германия', form: 'Таблетки',
    price: 54_000, popularity: 40, stock: 0, categories: ['zinc', 'immunity', 'beauty-hair'],
    keywords: 'zinc chelate бисглицинат', description: 'Для иммунитета, кожи и волос.', directions: '1 таблетка в день.' },
  { sku: 'VTL-PROBIO', ru: 'Пробиотик комплекс, 10 штаммов, 30 капсул', uz: 'Probiotik kompleks, 10 shtamm, 30 kapsula', brand: 'BioFlora', manufacturer: 'BioFlora Ltd', country: 'Великобритания', form: 'Капсулы',
    price: 168_000, popularity: 30, stock: 15, categories: ['probiotics', 'immunity'],
    keywords: 'probiotic лактобактерии бифидобактерии', description: 'Поддержка микрофлоры кишечника.', directions: '1 капсула утром натощак.' },
  { sku: 'VTL-MELATONIN', ru: 'Мелатонин 3 мг, 60 таблеток', uz: 'Melatonin 3 mg, 60 tabletka', brand: 'NightCalm', manufacturer: 'NightCalm Inc', country: 'США', form: 'Таблетки',
    price: 98_000, popularity: 70, stock: 25, categories: ['other', 'sleep'],
    keywords: 'melatonin сон sleep', description: 'Помогает быстрее заснуть.', directions: '1 таблетка за 30 минут до сна.' },
  { sku: 'VTL-K2-MK7', ru: 'Витамин K2 MK-7 100 мкг, 60 капсул', uz: 'Vitamin K2 MK-7 100 mkg, 60 kapsula', brand: 'SunVita', manufacturer: 'SunVita Labs', country: 'США', form: 'Капсулы',
    price: 115_000, popularity: 25, stock: 25, reserved: 1, categories: ['vitamin-k', 'heart', 'joints'],
    keywords: 'менахинон menaquinone', description: 'Направляет кальций в кости.', directions: '1 капсула в день.' },
  { sku: 'VTL-BIOTIN', ru: 'Биотин 5000 мкг, 60 капсул', uz: 'Biotin 5000 mkg, 60 kapsula', brand: 'BeautyLab', manufacturer: 'BeautyLab Co', country: 'Корея', form: 'Капсулы',
    price: 76_000, popularity: 60, stock: 35, categories: ['vitamin-b', 'beauty-hair'],
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

// Online providers stay disabled until the payments stage; timeouts per Master TZ §10.
const PAYMENT_METHODS = [
  { code: 'bank_transfer', name_ru: 'Банковский перевод', name_uz: 'Bank o‘tkazmasi', status: 'enabled' as const, timeout_minutes: 12 * 60 },
  { code: 'payme', name_ru: 'Payme', name_uz: 'Payme', status: 'disabled' as const, timeout_minutes: 30 },
  { code: 'click', name_ru: 'Click', name_uz: 'Click', status: 'disabled' as const, timeout_minutes: 30 },
  { code: 'uzum', name_ru: 'Uzum', name_uz: 'Uzum', status: 'disabled' as const, timeout_minutes: 30 },
];

// Clearly fake requisites for dev/test; real ones are entered by the admin.
const BANK_TRANSFER_DETAILS = {
  recipient: 'ООО «VITALO» (ТЕСТОВЫЕ РЕКВИЗИТЫ)',
  bank_name: 'Тестовый банк',
  account: '20208000000000000001',
  mfo: '00000',
  inn: '000000000',
  purpose_template: 'Оплата заказа {order_number}',
};

// Dev staff account (fake Telegram id, also used by e2e tests). Log in with: npm run dev:login -- --staff
const DEV_MANAGER_TELEGRAM_ID = 222_222_222;

async function seedCheckoutSettings() {
  for (const m of PAYMENT_METHODS) {
    await prisma.payment_methods.upsert({ where: { code: m.code }, create: m, update: { name_ru: m.name_ru, name_uz: m.name_uz } });
  }
  await prisma.settings.upsert({
    where: { key: 'bank_transfer_details' },
    create: { key: 'bank_transfer_details', value: BANK_TRANSFER_DETAILS },
    update: {},
  });
  for (const t of TARIFFS) {
    const id = uid(`tariff:${t.region}:${t.city ?? '*'}`);
    const data = {
      region_id: uid(`region:${t.region}`),
      city_id: t.city ? uid(`city:${t.region}:${t.city}`) : null,
      tariff_uzs: BigInt(t.tariff),
      free_shipping_threshold_uzs: BigInt(t.threshold),
      status: 'active' as const,
    };
    await prisma.delivery_tariffs.upsert({ where: { id }, create: { id, ...data }, update: data });
  }
  await prisma.staff_users.upsert({
    where: { telegram_user_id: BigInt(DEV_MANAGER_TELEGRAM_ID) },
    create: { telegram_user_id: BigInt(DEV_MANAGER_TELEGRAM_ID), name: 'Менеджер (тест)', role: 'manager' },
    update: {},
  });
}

async function seedRegions() {
  for (const r of REGIONS) {
    const regionId = uid(`region:${r.key}`);
    await prisma.regions.upsert({
      where: { id: regionId },
      create: { id: regionId, name_ru: r.ru, name_uz: r.uz },
      update: { name_ru: r.ru, name_uz: r.uz, status: 'active' },
    });
    for (const [ru, uz] of r.cities) {
      const cityId = uid(`city:${r.key}:${ru}`);
      await prisma.cities.upsert({
        where: { id: cityId },
        create: { id: cityId, region_id: regionId, name_ru: ru, name_uz: uz },
        update: { name_ru: ru, name_uz: uz, status: 'active' },
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
        update: data,
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
    const data = {
      name_ru: p.ru, name_uz: p.uz, brand: p.brand, manufacturer: p.manufacturer, country: p.country, form: p.form,
      price_uzs: BigInt(p.price), old_price_uzs: p.old ? BigInt(p.old) : null,
      status: 'active' as const, popularity_30d: p.popularity, search_keywords: p.keywords,
      short_description_ru: p.description, directions_ru: p.directions,
      warnings_ru: 'Не является лекарственным средством. Перед применением проконсультируйтесь с врачом.',
      created_at: new Date(BASE_DATE + i * 86_400_000),
    };
    const product = await prisma.products.upsert({
      where: { sku: p.sku },
      create: { id: uid(`product:${p.sku}`), sku: p.sku, ...data },
      update: data,
    });
    productIds.set(p.sku, product.id);

    await prisma.product_categories.deleteMany({ where: { product_id: product.id } });
    await prisma.product_categories.createMany({
      data: p.categories.map((slug) => ({ product_id: product.id, category_id: categoryIds.get(slug)! })),
    });

    await prisma.product_media.deleteMany({ where: { product_id: product.id } });
    await prisma.product_media.create({
      data: { product_id: product.id, media_type: 'image', is_main: true, url: `https://placehold.co/600x600/png?text=${encodeURIComponent(p.sku)}` },
    });

    await prisma.inventory.upsert({
      where: { product_id_warehouse_id: { product_id: product.id, warehouse_id: WAREHOUSE_ID } },
      create: { product_id: product.id, warehouse_id: WAREHOUSE_ID, actual_qty: p.stock, reserved_qty: p.reserved ?? 0 },
      update: { actual_qty: p.stock, reserved_qty: p.reserved ?? 0 },
    });

    // Receipt history only on first seed, so re-runs don't pile up movements.
    const hasBatch = await prisma.inventory_batches.findFirst({ where: { product_id: product.id } });
    if (!hasBatch && p.stock > 0) {
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

async function main() {
  await seedRegions();
  const categoryIds = await seedCategories();
  await seedProducts(categoryIds);
  await seedCheckoutSettings();
  console.log(
    `Seed done: ${REGIONS.length} regions, ${categoryIds.size} categories, ${PRODUCTS.length} products, ` +
      `${TARIFFS.length} tariffs, ${PAYMENT_METHODS.length} payment methods, 1 dev manager.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
