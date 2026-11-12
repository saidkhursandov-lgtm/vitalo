import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { csvCell } from '../src/staff/admin-export';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, loginStaff } from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;

/** Аудит админки 2.14: CSV for Excel — orders, stock, product analytics, expenses; by permissions; export.* in the audit. */
describe('Admin export to CSV (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const get = (path: string, r: Role = 'admin') =>
    http()
      .get(`/api/staff/export/${path}`)
      .set(bearer(tokens[r]))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
      });
  const run = Date.now().toString(36).toUpperCase();

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('stock: UTF-8 with BOM, «;», Russian headers, every product (also without movement); audited', async () => {
    const p = await createTestProduct(prisma, { price: 10_000, stock: 7, name: `Выгрузка; "${run}"` });
    const before = await prisma.audit_logs.count({ where: { action: 'export.stock' } });
    const res = await get(`stock?q=${run}`, 'warehouse').expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="vitalo-ostatki-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = res.body as string;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Артикул;Товар;На складе;В резерве;Доступно;Минимум;Дней запаса;Мало');
    expect(lines).toContain(`${p.sku};"Выгрузка; ""${run}""";7;0;7;0;;`);
    expect(await prisma.audit_logs.count({ where: { action: 'export.stock' } })).toBe(before + 1);
  });

  it('orders: both channels with the same filter as the list', async () => {
    await prisma.marketplace_orders.create({ data: { external_number: `EXP-${run}`, order_date: new Date(), status: 'NEW', customer_name: 'Excel Тест', is_test: true } });
    const text = (await get(`orders?q=EXP-${run}`).expect(200)).body as string;
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Номер;Канал;Создан;Статус;Оплата;Статус оплаты;Покупатель;Штук;Сумма, сум;Тестовый');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(new RegExp(`^EXP-${run};Яндекс Маркет;\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2};Новый;;;Excel Тест;0;0;да$`));
  });

  it('money files only for finance.manage; nothing without a permission', async () => {
    await get('product-analytics?from=2026-11-01&to=2026-11-30').expect(200);
    await get('expenses').expect(200);
    for (const r of ['manager', 'warehouse', 'marketer'] as Role[]) {
      await get('product-analytics?from=2026-11-01&to=2026-11-30', r).expect(403);
      await get('expenses', r).expect(403);
    }
    await get('orders', 'marketer').expect(403);
    await get('stock', 'marketer').expect(403);
    await get('product-analytics').expect(400);
  });

  it('a text cell cannot become an Excel formula', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+998901112233')).toBe("'+998901112233");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
  });
});
