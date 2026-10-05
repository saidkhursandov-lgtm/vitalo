import { spawnSync } from 'child_process';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { bootstrapReferenceData } from '../prisma/bootstrap';
import { CATEGORIES, type CategorySeed } from '../prisma/reference-data';

describe('Production bootstrap (e2e)', () => {
  const prisma = new PrismaClient();
  afterAll(() => prisma.$disconnect());

  it('adds only reference data, never products or people; running it again changes nothing', async () => {
    const before = { products: await prisma.products.count(), staff: await prisma.staff_users.count(), users: await prisma.users.count(), regions: await prisma.regions.count() };
    await bootstrapReferenceData(prisma);
    const second = await bootstrapReferenceData(prisma);
    expect(second).toEqual({ categories: 0, payment_methods: 0, settings: 0, warehouses: 0 });
    expect({ products: await prisma.products.count(), staff: await prisma.staff_users.count(), users: await prisma.users.count(), regions: await prisma.regions.count() }).toEqual(before);

    const slugs = (list: CategorySeed[]): string[] => list.flatMap((c) => [c.slug, ...slugs(c.children ?? [])]);
    const all = [...slugs(CATEGORIES.need), ...slugs(CATEGORIES.product_type)];
    expect(await prisma.categories.count({ where: { slug: { in: all } } })).toBe(all.length);
    expect(await prisma.payment_methods.count({ where: { code: { in: ['card_transfer', 'bank_transfer'] }, status: 'enabled' } })).toBe(2);
    expect(await prisma.warehouses.count({ where: { address: { contains: 'Ташкент' } } })).toBeGreaterThan(0);
    expect(await prisma.settings.findUnique({ where: { key: 'support_contact' } })).not.toBeNull();
  });

  it('the demo seed refuses to run with NODE_ENV=production', () => {
    const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['ts-node', 'prisma/seed.ts'], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'production' }, // DATABASE_URL is the test database anyway
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain('refuses NODE_ENV=production');
  }, 60_000);
});
