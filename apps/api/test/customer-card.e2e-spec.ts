import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bearer, createTestApp, loginCustomer, loginStaff } from './helpers';

const STAFF_TG = { admin: 222_222_221, manager: 222_222_222, warehouse: 222_222_223, marketer: 222_222_224 } as const;
type Role = keyof typeof STAFF_TG;

/** Аудит админки 4.1: the customer card — all orders, activity, support, compatibility, notes; styled names found. */
describe('Customer card (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const tg = 975_300_000 + Math.floor(Math.random() * 90_000);
  let userId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    for (const r of Object.keys(STAFF_TG) as Role[]) tokens[r] = await loginStaff(app, STAFF_TG[r]);
    await loginCustomer(app, tg);
    const u = await prisma.users.findUniqueOrThrow({ where: { telegram_user_id: BigInt(tg) } });
    userId = u.id;
    // a name written with styled Unicode letters (as some Telegram profiles are)
    await prisma.users.update({ where: { id: userId }, data: { first_name: '𝓐𝓷𝓪𝓼𝓽𝓪𝓼𝓲𝔂𝓪', last_name: `T${tg}` } });
  });
  afterAll(async () => {
    await app.close();
  });

  it('a styled name is found by plain letters', async () => {
    const ids = (await http().get('/api/staff/customers?q=anastasiya').set(bearer(tokens.manager)).expect(200)).body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(userId);
  });

  it('the list and the card show all orders, activity, subscription; notes are added and audited', async () => {
    const row = (await http().get(`/api/staff/customers?q=T${tg}`).set(bearer(tokens.manager)).expect(200)).body.items[0];
    expect(row).toMatchObject({ id: userId, total_orders: 0, paid_orders: 0, marketing_opt_in: true });
    expect(new Date(row.last_activity_at).getTime()).toBeGreaterThan(Date.now() - 3600_000); // the sign-in a moment ago

    const card = (await http().get(`/api/staff/customers/${userId}`).set(bearer(tokens.manager)).expect(200)).body;
    expect(card).toMatchObject({ total_orders: 0, support: [], compat: [], notes: [] });

    await http().post(`/api/staff/customers/${userId}/notes`).set(bearer(tokens.manager)).send({ text: '   ' }).expect(400);
    const after = (await http().post(`/api/staff/customers/${userId}/notes`).set(bearer(tokens.manager)).send({ text: 'Звонить после 18:00' }).expect(200)).body;
    expect(after.notes).toEqual([expect.objectContaining({ text: 'Звонить после 18:00', staff_name: expect.any(String) })]);
    expect(await prisma.audit_logs.count({ where: { action: 'customer.note_added', entity_id: userId } })).toBe(1);
  });

  it('roles without customers.view see nothing', async () => {
    for (const r of ['warehouse', 'marketer'] as Role[]) {
      await http().get(`/api/staff/customers/${userId}`).set(bearer(tokens[r])).expect(403);
      await http().post(`/api/staff/customers/${userId}/notes`).set(bearer(tokens[r])).send({ text: 'x' }).expect(403);
    }
  });
});
