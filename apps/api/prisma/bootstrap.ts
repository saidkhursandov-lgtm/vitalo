import { Prisma, PrismaClient, TreeType } from '@prisma/client';
import { SETTING_DEFAULTS } from '../src/settings/settings.service';
import { BANK_TRANSFER_DETAILS, CATEGORIES, PAYMENT_METHODS, uid, type CategorySeed } from './reference-data';

/**
 * Production bootstrap (npm run bootstrap:prod): the reference data a fresh shop needs and nothing else —
 * category trees, payment methods, default settings, one warehouse in Tashkent.
 * NO products, NO customers, NO employees, NO extra regions (regions, cities and test tariffs come from the
 * migrations). Only creates what is missing: running it again changes nothing, admin edits stay untouched.
 */
export async function bootstrapReferenceData(prisma: PrismaClient) {
  const created = { categories: 0, payment_methods: 0, settings: 0, warehouses: 0 };

  const walk = async (tree: TreeType, list: CategorySeed[], parentId: string | null) => {
    for (const [i, c] of list.entries()) {
      const existing = await prisma.categories.findUnique({ where: { slug: c.slug } });
      const row =
        existing ??
        (await prisma.categories.create({
          data: { id: uid(`category:${c.slug}`), slug: c.slug, tree_type: tree, parent_id: parentId, name_ru: c.ru, name_uz: c.uz, sort_order: (i + 1) * 10 },
        }));
      if (!existing) created.categories++;
      if (c.children) await walk(tree, c.children, row.id);
    }
  };
  for (const tree of Object.keys(CATEGORIES) as TreeType[]) await walk(tree, CATEGORIES[tree], null);

  for (const m of PAYMENT_METHODS) {
    if (await prisma.payment_methods.findUnique({ where: { code: m.code } })) continue;
    await prisma.payment_methods.create({ data: m });
    created.payment_methods++;
  }

  // Bank requisites start as clearly marked TEST values: the admin replaces them in Настройки → Оплата.
  const settings = { bank_transfer_details: BANK_TRANSFER_DETAILS, ...SETTING_DEFAULTS } as unknown as Record<string, Prisma.InputJsonValue>;
  for (const [key, value] of Object.entries(settings)) {
    if (await prisma.settings.findUnique({ where: { key } })) continue;
    await prisma.settings.create({ data: { key, value } });
    created.settings++;
  }

  // Stock is booked to the warehouse in Tashkent (Excel import, admin receipts).
  const warehouses = await prisma.warehouses.findMany({ where: { status: 'active' } });
  if (!warehouses.some((w) => /ташкент|toshkent|tashkent/i.test(`${w.name} ${w.address ?? ''}`))) {
    await prisma.warehouses.create({ data: { id: uid('warehouse:main'), name: 'Основной склад', address: 'г. Ташкент' } });
    created.warehouses++;
  }
  return created;
}
