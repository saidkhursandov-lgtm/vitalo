import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { applyAfterTransfer, planAfterTransfer, SEED_STAFF_TELEGRAM_IDS } from '../src/ops/after-transfer';
import { PrismaService } from '../src/prisma/prisma.service';
import { bearer, createTestApp, loginStaff } from './helpers';

describe('Block E: health check and «after the transfer» (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    // the other test files sign in as the demo employees
    await prisma.staff_users.updateMany({ where: { telegram_user_id: { in: SEED_STAFF_TELEGRAM_IDS } }, data: { status: 'active' } });
    await app.close();
  });

  it('GET /api/health: public, 200, only the status — nothing secret or internal', async () => {
    const res = await http().get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', db: true, yandex_sync: { enabled: false, stale: false } });
    expect(Object.keys(res.body).sort()).toEqual(['db', 'status', 'time', 'yandex_sync']);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toMatch(/token|secret|key|password|postgres|version/i);
  });

  it('after the transfer: queued messages are not sent, sign-ins and demo employees are switched off; orders, units and history are untouched', async () => {
    const token = await loginStaff(app, Number(SEED_STAFF_TELEGRAM_IDS[0]));
    await http().get('/api/staff/auth/me').set(bearer(token)).expect(200);
    const admin = await prisma.staff_users.findFirstOrThrow({ where: { telegram_user_id: SEED_STAFF_TELEGRAM_IDS[0] } });
    const queued = await prisma.notifications.create({ data: { staff_user_id: admin.id, chat_id: admin.telegram_user_id, kind: 'service', template: 'staff.yandex_late_summary', payload: { order_number: '', count: 1 } } });
    const sent = await prisma.notifications.create({ data: { staff_user_id: admin.id, chat_id: admin.telegram_user_id, kind: 'service', template: 'staff.yandex_late_summary', payload: { order_number: '', count: 1 }, status: 'sent', sent_at: new Date() } });
    const before = {
      orders: await prisma.orders.count(),
      yandex: await prisma.marketplace_orders.count(),
      units: await prisma.physical_units.count(),
      events: await prisma.physical_unit_events.count(),
      movements: await prisma.inventory_movements.count(),
      products: await prisma.products.count(),
      customers: await prisma.users.count(),
    };

    // dry run: a plan and nothing else
    const plan = await planAfterTransfer(prisma, 'vitalo_test');
    expect(plan.queuedNotifications).toBeGreaterThan(0);
    expect(plan.staffSessions).toBeGreaterThan(0);
    expect(plan.seedStaff.map((s) => s.role).sort()).toEqual(['admin', 'manager', 'marketer', 'warehouse']);
    expect(plan.warnings.join('\n')).toMatch(/ТЕСТОВЫЕ данные карты/);
    expect(plan.warnings.join('\n')).toMatch(/Нет ни одного настоящего активного администратора/);
    expect((await prisma.notifications.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('queued');
    await http().get('/api/staff/auth/me').set(bearer(token)).expect(200);

    const done = await applyAfterTransfer(prisma, plan);
    expect(done.seed_staff_blocked).toBe(4);
    expect((await prisma.notifications.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('skipped');
    expect((await prisma.notifications.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe('sent'); // history stays
    expect(await prisma.notifications.count({ where: { status: { in: ['queued', 'sending'] } } })).toBe(0);
    expect(await prisma.staff_sessions.count()).toBe(0);
    expect(await prisma.user_sessions.count()).toBe(0);
    await http().get('/api/staff/auth/me').set(bearer(token)).expect(401); // the old sign-in is gone
    expect(
      await prisma.audit_logs.count({ where: { action: 'server.after_transfer', after_json: { path: ['database'], equals: 'vitalo_test' } } }),
    ).toBeGreaterThan(0);
    expect({
      orders: await prisma.orders.count(),
      yandex: await prisma.marketplace_orders.count(),
      units: await prisma.physical_units.count(),
      events: await prisma.physical_unit_events.count(),
      movements: await prisma.inventory_movements.count(),
      products: await prisma.products.count(),
      customers: await prisma.users.count(),
    }).toEqual(before);

    // a second run finds nothing left to do
    const again = await planAfterTransfer(prisma, 'vitalo_test');
    expect(again).toMatchObject({ queuedNotifications: 0, userSessions: 0, staffSessions: 0, seedStaff: [] });
  });
});
