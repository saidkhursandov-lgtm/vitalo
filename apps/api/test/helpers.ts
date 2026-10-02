import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { signInitData } from '../src/auth/sign-init-data';
import { PrismaService } from '../src/prisma/prisma.service';

/** Seeded dev manager (prisma/seed.ts). */
export const DEV_MANAGER_TG = 222_222_222;
/** Brand of products created by tests; such products are archived after each suite. */
export const TEST_BRAND = 'E2E';

/** `customize` can replace providers, e.g. the Telegram sender with a fake. */
export async function createTestApp(customize?: (b: TestingModuleBuilder) => TestingModuleBuilder): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  const moduleRef = await (customize ? customize(builder) : builder).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  // Listen once on a random port: otherwise supertest binds a new port per request,
  // which floods listeners when tests fire many requests in parallel.
  await app.listen(0);
  return app;
}

export function makeInitData(
  user: Record<string, unknown>,
  opts: { authDate?: number; botToken?: string } = {},
): string {
  const authDate = opts.authDate ?? Math.floor(Date.now() / 1000);
  return signInitData(
    { auth_date: String(authDate), user: JSON.stringify(user) },
    opts.botToken ?? process.env.TELEGRAM_BOT_TOKEN!,
  );
}

export async function loginCustomer(app: INestApplication, telegramId: number): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/auth/telegram')
    .send({ initData: makeInitData({ id: telegramId, first_name: `User${telegramId}` }) })
    .expect(200);
  return res.body.token;
}

export async function loginStaff(app: INestApplication, telegramId: number): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/staff/auth/telegram')
    .send({ initData: makeInitData({ id: telegramId, first_name: 'Staff' }) })
    .expect(200);
  return res.body.token;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let skuCounter = 0;

/** Active product with stock in the seeded warehouse. */
export async function createTestProduct(
  prisma: PrismaService,
  opts: { price: number; stock: number; reserved?: number; name?: string },
) {
  const warehouse = await prisma.warehouses.findFirstOrThrow({ orderBy: { name: 'asc' } });
  const sku = `E2E-${process.pid}-${Date.now()}-${++skuCounter}`;
  return prisma.products.create({
    data: {
      sku,
      name_ru: opts.name ?? `Тестовый товар ${sku}`,
      brand: TEST_BRAND,
      manufacturer: 'Test',
      price_uzs: BigInt(opts.price),
      inventory: { create: { warehouse_id: warehouse.id, actual_qty: opts.stock, reserved_qty: opts.reserved ?? 0 } },
    },
  });
}

export async function setStock(prisma: PrismaService, productId: string, actual: number) {
  await prisma.inventory.updateMany({ where: { product_id: productId }, data: { actual_qty: actual } });
}

export async function stockOf(prisma: PrismaService, productId: string) {
  const inv = await prisma.inventory.findFirstOrThrow({ where: { product_id: productId } });
  return { actual: inv.actual_qty, reserved: inv.reserved_qty };
}

export async function archiveTestProducts(prisma: PrismaService) {
  await prisma.products.updateMany({ where: { brand: TEST_BRAND }, data: { status: 'archived' } });
}

/** Seeded addresses: Tashkent (20 000, free from 300 000), Kattakurgan city override (45 000). */
export async function seededAddresses(prisma: PrismaService) {
  const city = async (name: string) => {
    const c = await prisma.cities.findFirstOrThrow({ where: { name_ru: name } });
    return { region_id: c.region_id, city_id: c.id };
  };
  return {
    tashkent: await city('Юнусабадский район'),
    samarkand: await city('Самарканд'),
    kattakurgan: await city('Каттакурган'),
  };
}
