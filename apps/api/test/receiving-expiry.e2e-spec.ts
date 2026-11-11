import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ReceivingExpiryService } from '../src/receiving/receiving-expiry.service';
import { archiveTestProducts, createTestApp, createTestProduct } from './helpers';

/** Аудит админки 10.11, п. 1.14: пустая приёмка старше суток отменяется сама, непустая — только напоминание. */
describe('Receiving expiry (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let job: ReceivingExpiryService;
  const suppliers: string[] = [];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    job = app.get(ReceivingExpiryService);
  });
  afterAll(async () => {
    await prisma.receiving_sessions.updateMany({ where: { supplier_id: { in: suppliers } }, data: { status: 'CANCELLED' } });
    await prisma.suppliers.updateMany({ where: { id: { in: suppliers } }, data: { status: 'archived' } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  const session = async (hoursAgo: number) => {
    const supplier = await prisma.suppliers.create({ data: { name: `Приёмка-тест ${Date.now()}-${suppliers.length}` } });
    suppliers.push(supplier.id);
    const warehouse = await prisma.staff_users.findFirstOrThrow({ where: { role: 'warehouse', status: 'active' } });
    return prisma.receiving_sessions.create({
      data: { type: 'PURCHASE', supplier_id: supplier.id, created_by: warehouse.id, created_at: new Date(Date.now() - hoursAgo * 3600_000) },
    });
  };
  const reminders = (id: string) => prisma.notifications.count({ where: { template: 'staff.receiving_open_reminder', payload: { path: ['session_id'], equals: id } } });

  it('empty and older than a day → cancelled, the creator gets a message; a fresh one is left alone', async () => {
    const old = await session(25);
    const fresh = await session(2);
    await job.runOnce();
    expect((await prisma.receiving_sessions.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('CANCELLED');
    expect((await prisma.receiving_sessions.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('OPEN');
    const note = await prisma.notifications.findFirst({ where: { template: 'staff.receiving_auto_cancelled', payload: { path: ['session_id'], equals: old.id } } });
    expect(note?.staff_user_id).toBe(old.created_by);
    expect(await prisma.audit_logs.count({ where: { action: 'receiving.cancelled', entity_id: old.id, staff_user_id: null } })).toBe(1);
  });

  it('with accepted goods → stays open, one reminder a day', async () => {
    const s = await session(30);
    const p = await createTestProduct(prisma, { price: 10_000, stock: 0 });
    await prisma.receiving_session_lines.create({ data: { session_id: s.id, product_id: p.id, qty: 2, expiry_date_groups: [{ expiry: '2028-01-01', qty: 2 }] } });
    await job.runOnce();
    await job.runOnce(); // the same day: no second reminder
    expect((await prisma.receiving_sessions.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('OPEN');
    expect(await reminders(s.id)).toBe(1);
  });
});
