import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { tashkentDateString } from '../src/common/tashkent';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginCustomer, loginStaff, seededAddresses } from './helpers';

const ADMIN_TG = 222_222_221;

/** A geocoder answer as Yandex gives it (only the parts we read). */
function yandexAnswer(components: [string, string][]) {
  return {
    response: {
      GeoObjectCollection: {
        featureMember: [{ GeoObject: { name: 'x', metaDataProperty: { GeocoderMetaData: { Address: { formatted: 'f', Components: components.map(([kind, name]) => ({ kind, name })) } } } } }],
      },
    },
  };
}
const YUNUSABAD = yandexAnswer([
  ['country', 'Узбекистан'],
  ['province', 'Ташкент'],
  ['locality', 'Ташкент'],
  ['district', 'Юнусабадский район'],
  ['street', 'улица Амира Темура'],
  ['house', '107'],
]);
/** A point on a street, not on a house: Yandex names the street but not the district. */
const STREET_ONLY = yandexAnswer([
  ['country', 'Узбекистан'],
  ['province', 'Ташкент'],
  ['locality', 'Ташкент'],
  ['street', 'улица Ахмада Дониша'],
]);
const DISTRICT_ONLY = yandexAnswer([
  ['country', 'Узбекистан'],
  ['province', 'Ташкент'],
  ['locality', 'Ташкент'],
  ['district', 'Юнусабадский район'],
  ['district', 'махалля Биллур'],
]);
const PASTDARGOM = yandexAnswer([
  ['country', 'Узбекистан'],
  ['province', 'Самаркандская область'],
  ['area', 'Пастдаргомский район'],
]);

/** 3.6: «Адрес на Яндекс Карте» — the map config, the geocoder with its daily limit, the point in orders and staff messages. */
describe('Stage 3.6 map (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let addr: Awaited<ReturnType<typeof seededAddresses>>;
  let admin: string;
  let manager: string;
  let customer: string;
  let tg = 836_100_000;
  const http = () => request(app.getHttpServer());
  const realFetch = global.fetch;
  let geocoderCalls: string[] = [];
  let nextAnswer: { status: number; body: unknown } = { status: 200, body: YUNUSABAD };
  let districtAnswer: unknown = null;

  const setKeys = (js: string, geo: string) => {
    process.env.YANDEX_MAPS_JS_API_KEY = js;
    process.env.YANDEX_GEOCODER_API_KEY = geo;
  };
  const setUsage = (n: number, js = 0) =>
    prisma.settings.upsert({
      where: { key: 'maps_usage' },
      create: { key: 'maps_usage', value: { date: tashkentDateString(new Date()), geocoder: n, js } },
      update: { value: { date: tashkentDateString(new Date()), geocoder: n, js } },
    });
  const usage = async (kind: 'geocoder' | 'js' = 'geocoder') =>
    ((await prisma.settings.findUnique({ where: { key: 'maps_usage' } }))?.value as Record<string, number> | undefined)?.[kind] ?? 0;
  // a new point every time: the answers are cached for an hour per point
  let step = 0;
  const point = () => ({ lat: (41.33 + ++step * 0.001).toFixed(4), lon: '69.28' });

  beforeAll(async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://geocode-maps.yandex.ru/')) return realFetch(input, init);
      geocoderCalls.push(url);
      if (url.includes('&kind=district') && districtAnswer) return new Response(JSON.stringify(districtAnswer), { status: 200 });
      return new Response(JSON.stringify(nextAnswer.body), { status: nextAnswer.status, headers: { 'content-type': 'application/json' } });
    });
    app = await createTestApp();
    prisma = app.get(PrismaService);
    addr = await seededAddresses(prisma);
    admin = await loginStaff(app, ADMIN_TG);
    manager = await loginStaff(app, DEV_MANAGER_TG);
    customer = await loginCustomer(app, ++tg);
    await prisma.settings.deleteMany({ where: { key: { in: ['maps', 'maps_usage'] } } });
  });
  beforeEach(() => {
    geocoderCalls = [];
    nextAnswer = { status: 200, body: YUNUSABAD };
    districtAnswer = null;
    setKeys('js-test-key', 'geo-test-key');
  });
  afterAll(async () => {
    setKeys('', '');
    jest.restoreAllMocks();
    await prisma.settings.deleteMany({ where: { key: { in: ['maps', 'maps_usage'] } } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('without the keys the map is not offered and the geocoder is not asked', async () => {
    setKeys('', '');
    expect((await http().get('/api/maps/config').set(bearer(customer)).expect(200)).body).toEqual({ available: false, reason: 'no_key' });
    expect((await http().post('/api/maps/open').set(bearer(customer)).expect(503)).body).toMatchObject({ code: 'MAP_UNAVAILABLE', reason: 'no_key' });
    const res = await http().get('/api/maps/geocode').query(point()).set(bearer(customer)).expect(503);
    expect(res.body.code).toBe('MAP_UNAVAILABLE');
    expect(geocoderCalls).toHaveLength(0);
  });

  it('only for a signed-in customer', async () => {
    await http().get('/api/maps/config').expect(401);
    await http().post('/api/maps/open').expect(401);
    await http().get('/api/maps/geocode').query(point()).expect(401);
  });

  it('with the keys: the map key comes only with a counted opening; the address with our region and district; each request is counted', async () => {
    expect((await http().get('/api/maps/config').set(bearer(customer)).expect(200)).body).toEqual({ available: true, reason: null });
    const loads = await usage('js');
    expect((await http().post('/api/maps/open').set(bearer(customer)).expect(200)).body).toEqual({ js_api_key: 'js-test-key' });
    expect(await usage('js')).toBe(loads + 1);
    const before = await usage();
    const p = point();
    const res = (await http().get('/api/maps/geocode').query({ ...p, lang: 'ru' }).set(bearer(customer)).expect(200)).body;
    expect(res).toEqual({
      found: true,
      outside: false,
      street_line: 'улица Амира Темура, 107',
      full_text: 'Ташкент, Юнусабадский район, улица Амира Темура, 107',
      ...addr.tashkent,
    });
    expect(geocoderCalls).toHaveLength(1);
    expect(geocoderCalls[0]).toContain(`geocode=${Number(p.lon).toFixed(6)},${Number(p.lat).toFixed(6)}`);
    expect(geocoderCalls[0]).toContain('lang=ru_RU');
    expect(await usage()).toBe(before + 1);
    // the same point again: from the cache, no new request
    await http().get('/api/maps/geocode').query({ ...p, lang: 'ru' }).set(bearer(customer)).expect(200);
    expect(geocoderCalls).toHaveLength(1);
    expect(await usage()).toBe(before + 1);
  });

  it('a point on a street without the district: one more (counted) question to Yandex — only the district', async () => {
    nextAnswer = { status: 200, body: STREET_ONLY };
    districtAnswer = DISTRICT_ONLY;
    const before = await usage();
    const res = (await http().get('/api/maps/geocode').query({ ...point(), lang: 'ru' }).set(bearer(customer)).expect(200)).body;
    expect(res).toMatchObject({ found: true, street_line: 'улица Ахмада Дониша', ...addr.tashkent });
    expect(geocoderCalls).toHaveLength(2);
    expect(geocoderCalls[0]).not.toContain('kind=');
    expect(geocoderCalls[1]).toContain('&kind=district');
    expect(await usage()).toBe(before + 2);
    // Yandex cannot tell the district either: the region stays, the customer picks the district
    districtAnswer = { response: { GeoObjectCollection: { featureMember: [] } } };
    const res2 = (await http().get('/api/maps/geocode').query({ ...point(), lang: 'ru' }).set(bearer(customer)).expect(200)).body;
    expect(res2).toMatchObject({ found: true, region_id: addr.tashkent.region_id, city_id: null });
  });

  it('a district we do not have: only the region (the customer picks the district); Uzbek asks uz_UZ', async () => {
    nextAnswer = { status: 200, body: PASTDARGOM };
    const res = (await http().get('/api/maps/geocode').query({ ...point(), lang: 'uz' }).set(bearer(customer)).expect(200)).body;
    expect(res).toMatchObject({ found: true, street_line: '', region_id: addr.samarkand.region_id, city_id: null });
    expect(geocoderCalls[0]).toContain('lang=uz_UZ');
  });

  it('outside Uzbekistan: no request at all', async () => {
    const res = (await http().get('/api/maps/geocode').query({ lat: 55.75, lon: 37.62 }).set(bearer(customer)).expect(200)).body;
    expect(res).toMatchObject({ found: false, outside: true });
    expect(geocoderCalls).toHaveLength(0);
  });

  it('Yandex refuses (wrong key, its limit): a clear 503, the manual address still works', async () => {
    nextAnswer = { status: 403, body: { statusCode: 403, error: 'Forbidden', message: 'Invalid api key' } };
    const res = await http().get('/api/maps/geocode').query(point()).set(bearer(customer)).expect(503);
    expect(res.body).toMatchObject({ code: 'MAP_UNAVAILABLE', reason: 'geocoder' });
    expect(JSON.stringify(res.body)).not.toContain('geo-test-key');
  });

  it('daily limit: the button hides at 900, the geocoder stops at 950; the counter starts again on a new day', async () => {
    await setUsage(899);
    expect((await http().get('/api/maps/config').set(bearer(customer)).expect(200)).body.available).toBe(true);
    await setUsage(900);
    expect((await http().get('/api/maps/config').set(bearer(customer)).expect(200)).body).toEqual({ available: false, reason: 'limit' });
    await http().post('/api/maps/open').set(bearer(customer)).expect(503);
    // a map already open finishes its lookups
    await http().get('/api/maps/geocode').query(point()).set(bearer(customer)).expect(200);
    await setUsage(950);
    expect((await http().get('/api/maps/geocode').query(point()).set(bearer(customer)).expect(503)).body.reason).toBe('limit');
    expect(geocoderCalls).toHaveLength(1);
    await prisma.settings.update({ where: { key: 'maps_usage' }, data: { value: { date: '2020-01-01', geocoder: 999 } } });
    expect((await http().get('/api/maps/config').set(bearer(customer)).expect(200)).body.available).toBe(true);
  });

  it('the map itself (JavaScript API, 100 free loads a day): the button hides at 90 openings, no key is given after that', async () => {
    await setUsage(0, 89);
    const who = await loginCustomer(app, ++tg);
    await http().post('/api/maps/open').set(bearer(who)).expect(200);
    expect(await usage('js')).toBe(90);
    expect((await http().get('/api/maps/config').set(bearer(customer)).expect(200)).body).toEqual({ available: false, reason: 'limit' });
    expect((await http().post('/api/maps/open').set(bearer(who)).expect(503)).body).toMatchObject({ code: 'MAP_UNAVAILABLE', reason: 'limit' });
    expect(await usage('js')).toBe(90);
    // a geocoder request keeps the map counter as it is
    await setUsage(5, 40);
    await http().get('/api/maps/geocode').query(point()).set(bearer(who)).expect(200);
    expect([await usage('geocoder'), await usage('js')]).toEqual([6, 40]);
    await setUsage(0);
  });

  it('one customer cannot open the map again and again: 6 openings an hour, then 429', async () => {
    const greedy = await loginCustomer(app, ++tg);
    for (let i = 0; i < 6; i++) await http().post('/api/maps/open').set(bearer(greedy)).expect(200);
    expect((await http().post('/api/maps/open').set(bearer(greedy)).expect(429)).body.code).toBe('MAP_TOO_MANY');
    await setUsage(0);
  });

  it('one customer cannot spend the whole limit: 40 lookups in 10 minutes, then 429', async () => {
    const greedy = await loginCustomer(app, ++tg);
    for (let i = 0; i < 40; i++) await http().get('/api/maps/geocode').query(point()).set(bearer(greedy)).expect(200);
    expect((await http().get('/api/maps/geocode').query(point()).set(bearer(greedy)).expect(429)).body.code).toBe('MAP_TOO_MANY');
    await http().get('/api/maps/geocode').query(point()).set(bearer(customer)).expect(200); // others are not affected
  });

  it('Настройки → Доставка: the switch (admin, audited) and today’s counters; the manager cannot change it', async () => {
    await setUsage(812);
    const s = (await http().get('/api/staff/settings/maps').set(bearer(admin)).expect(200)).body;
    expect(s).toMatchObject({
      enabled: true,
      has_js_key: true,
      has_geocoder_key: true,
      available: true,
      geocoder: { limit: 1000, warn_at: 800, hide_at: 900 },
      js: { limit: 100, warn_at: 70, hide_at: 90 },
    });
    expect(s.today).toMatchObject({ geocoder_requests: 812, map_loads: 0 });
    expect(JSON.stringify(s)).not.toContain('test-key'); // keys themselves never leave the server here
    await http().put('/api/staff/settings/maps').set(bearer(manager)).send({ enabled: false }).expect(403);
    const off = (await http().put('/api/staff/settings/maps').set(bearer(admin)).send({ enabled: false }).expect(200)).body;
    expect(off).toMatchObject({ enabled: false, available: false, reason: 'off' });
    expect((await http().get('/api/maps/config').set(bearer(customer)).expect(200)).body).toEqual({ available: false, reason: 'off' });
    expect(await prisma.audit_logs.count({ where: { action: 'settings.maps_updated' } })).toBeGreaterThan(0);
    await http().put('/api/staff/settings/maps').set(bearer(admin)).send({ enabled: true }).expect(200);
    await setUsage(0);
  });

  it('map events are accepted from the app; the district result shows as sub-rows in the funnel', async () => {
    for (const [event, props] of [
      ['map_open', { place: 'checkout' }],
      ['map_locate_me', { result: 'denied' }],
      ['map_confirm', { place: 'checkout' }],
      ['map_district_auto', { matched: true }],
      ['map_district_auto', { matched: false }],
    ] as const)
      await http().post('/api/analytics/events').set(bearer(customer)).send({ event, props }).expect(202);
    const status = (await http().get('/api/staff/settings/maps').set(bearer(admin)).expect(200)).body;
    expect(status.today.map_confirms).toBeGreaterThan(0);
  });

  it('a saved address keeps the point, apartment, entrance, floor and landmark; empty clears them', async () => {
    const who = await loginCustomer(app, ++tg);
    const created = (
      await http()
        .post('/api/addresses')
        .set(bearer(who))
        .send({ ...addr.tashkent, address_text: 'улица Амира Темура, 107', latitude: 41.3401, longitude: 69.2856, apartment: '5', entrance: '2', floor: '3', landmark: 'напротив школы' })
        .expect(201)
    ).body;
    expect(created).toMatchObject({ latitude: 41.3401, longitude: 69.2856, apartment: '5', entrance: '2', floor: '3', landmark: 'напротив школы' });
    const edited = (await http().patch(`/api/addresses/${created.id}`).set(bearer(who)).send({ apartment: '', latitude: null, longitude: null }).expect(200)).body;
    expect(edited).toMatchObject({ apartment: null, entrance: '2', latitude: null, longitude: null });
  });

  it('an order with a point: «Открыть в Яндекс Картах» in the staff message; without a point — as before', async () => {
    const who = await loginCustomer(app, ++tg);
    const p = await createTestProduct(prisma, { price: 50_000, stock: 10 });
    const place = async (extra: object) =>
      (
        await http()
          .post('/api/orders')
          .set(bearer(who))
          .set('Idempotency-Key', randomUUID())
          .send({ source: 'buy_now', buy_now: { product_id: p.id, qty: 1 }, recipient_name: 'Карта Тест', recipient_phone: '90 123-45-67', ...addr.tashkent, address_text: 'улица Амира Темура, 107, кв. 5', payment_method: 'card_transfer', ...extra })
          .expect(201)
      ).body;
    const withPoint = await place({ latitude: 41.3401, longitude: 69.2856 });
    const without = await place({});
    const staffMsg = (orderNumber: string) =>
      prisma.notifications.findFirstOrThrow({ where: { template: 'staff.new_order', payload: { path: ['order_number'], equals: orderNumber } } });
    expect(((await staffMsg(withPoint.order_number)).payload as { map_url?: string }).map_url).toBe('https://yandex.uz/maps/?pt=69.285600,41.340100&z=17&l=map');
    expect(((await staffMsg(without.order_number)).payload as { map_url?: string }).map_url).toBeUndefined();
    const card = (await http().get(`/api/staff/orders/${withPoint.id}`).set(bearer(manager)).expect(200)).body;
    expect(card.delivery).toMatchObject({ latitude: 41.3401, longitude: 69.2856 });
  });
});
