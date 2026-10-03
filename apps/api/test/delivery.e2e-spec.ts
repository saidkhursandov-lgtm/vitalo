import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, seededAddresses } from './helpers';

describe('Delivery (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  const quote = (a: { region_id: string; city_id: string }, goods: number) =>
    request(app.getHttpServer()).get(`/api/delivery/quote?region_id=${a.region_id}&city_id=${a.city_id}&goods_total_uzs=${goods}`);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
  });
  afterAll(() => app.close());

  it('lists 3 regions with 2 cities each', async () => {
    const { body } = await request(app.getHttpServer()).get('/api/delivery/regions').expect(200);
    expect(body).toHaveLength(3);
    for (const r of body) expect(r.cities).toHaveLength(2);
  });

  it('uses the region tariff below the threshold', async () => {
    const { body } = await quote(addr.tashkent, 100_000).expect(200);
    expect(body).toMatchObject({ tariff_uzs: 20_000, free_shipping_threshold_uzs: 300_000, cost_uzs: 20_000, remaining_for_free_uzs: 200_000 });
  });

  it('is free from the threshold (inclusive)', async () => {
    expect((await quote(addr.tashkent, 300_000).expect(200)).body).toMatchObject({ cost_uzs: 0, is_free: true });
  });

  it('a city tariff overrides the region default', async () => {
    expect((await quote(addr.samarkand, 100_000).expect(200)).body.cost_uzs).toBe(35_000);
    expect((await quote(addr.kattakurgan, 100_000).expect(200)).body.cost_uzs).toBe(45_000);
  });

  it('delivery term: from the tariff, a city without its own term takes the region one (A3)', async () => {
    expect((await quote(addr.tashkent, 100_000).expect(200)).body).toMatchObject({ min_days: 2, max_days: 5 });
    expect((await quote(addr.kattakurgan, 100_000).expect(200)).body).toMatchObject({ cost_uzs: 45_000, min_days: 5, max_days: 10 });
    const eta = await request(app.getHttpServer()).get(`/api/delivery/eta?region_id=${addr.samarkand.region_id}&city_id=${addr.samarkand.city_id}`).expect(200);
    expect(eta.body).toMatchObject({ min_days: 5, max_days: 10 });
    const terms = await request(app.getHttpServer()).get('/api/delivery/terms').expect(200);
    expect(terms.body).toEqual({ tashkent: { min_days: 2, max_days: 5 }, regions: { min_days: 5, max_days: 10 } });
    const shop = await request(app.getHttpServer()).get('/api/catalog/texts').expect(200);
    expect(shop.body).toMatchObject({
      support_contact: '@VITALO_support',
      support_url: 'https://t.me/VITALO_support',
      payment_check_hours: { from: '08:00', to: '22:00' },
      delivery_days_label: { ru: 'рабочих дней', uz: 'ish kuni' },
      delivery_terms: terms.body,
    });
  });

  it('a city from another region is rejected', async () => {
    const res = await quote({ region_id: addr.tashkent.region_id, city_id: addr.samarkand.city_id }, 1).expect(400);
    expect(res.body.code).toBe('INVALID_ADDRESS');
  });

  it('no active tariff -> 422 DELIVERY_UNAVAILABLE', async () => {
    await prisma.delivery_tariffs.updateMany({ where: { region_id: addr.samarkand.region_id }, data: { status: 'disabled' } });
    try {
      const res = await quote(addr.samarkand, 1).expect(422);
      expect(res.body.code).toBe('DELIVERY_UNAVAILABLE');
    } finally {
      await prisma.delivery_tariffs.updateMany({ where: { region_id: addr.samarkand.region_id }, data: { status: 'active' } });
    }
  });
});
