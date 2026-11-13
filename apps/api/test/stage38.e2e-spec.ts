import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;
const SPECIALIST_TG = 838_000_001; // a marketer marked «специалист»
const MARKETER_TG = 838_000_002;

/** 3.8: dictionary of substances, compatibility rules and substances of products (D-45). */
describe('Stage 3.8 VITALO AI knowledge (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const run = Date.now().toString(36);
  const sub = (token: string, body: Record<string, unknown>) => http().post('/api/staff/compat/substances').set(bearer(token)).send(body);
  const byName = (list: { id: string; name_ru: string }[], name: string) => list.find((s) => s.name_ru === name)!;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    for (const [tg, name, specialist] of [
      [SPECIALIST_TG, 'Специалист 3.8', true],
      [MARKETER_TG, 'Маркетолог 3.8', false],
    ] as const) {
      await prisma.staff_users.upsert({
        where: { telegram_user_id: BigInt(tg) },
        create: { telegram_user_id: BigInt(tg), name, role: 'marketer', is_specialist: specialist },
        update: { status: 'active', role: 'marketer', is_specialist: specialist, name },
      });
    }
    tokens.admin = await loginStaff(app, ADMIN_TG);
    tokens.manager = await loginStaff(app, DEV_MANAGER_TG);
    tokens.specialist = await loginStaff(app, SPECIALIST_TG);
    tokens.marketer = await loginStaff(app, MARKETER_TG);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('the migration brings the starting dictionary; P-5-P is a form of B6', async () => {
    const list = (await http().get('/api/staff/compat/substances').set(bearer(tokens.manager)).expect(200)).body as { code: string; kind: string; parent: { name_ru: string } | null; synonyms: string[] }[];
    const p5p = list.find((s) => s.code === 'p5p')!;
    expect(p5p).toMatchObject({ kind: 'form', parent: { name_ru: 'Витамин B6' } });
    expect(list.find((s) => s.code === 'vitamin_d3')!.synonyms).toEqual(expect.arrayContaining(['d3', 'холекальциферол']));
    expect(list.filter((s) => s.kind === 'drug_group').length).toBeGreaterThanOrEqual(3);
  });

  it('a specialist adds substances; a manager and a plain marketer cannot', async () => {
    await (sub(tokens.manager, { name_ru: `Тест-вещество ${run}`, name_uz: 'Test' })).expect(403);
    await (sub(tokens.marketer, { name_ru: `Тест-вещество ${run}`, name_uz: 'Test' })).expect(403);
    const res = await (sub(tokens.specialist, { code: `t_a_${run}`, name_ru: `Тест A ${run}`, name_uz: 'Test A', synonyms: ['  ТЕСТ-А ', 'тест-а', 'x'] })).expect(200);
    expect(byName(res.body, `Тест A ${run}`)).toMatchObject({ synonyms: ['тест-а'], kind: 'substance', enabled: true });
    expect((await sub(tokens.specialist, { code: `t_a_${run}`, name_ru: 'Другое', name_uz: 'Boshqa' })).status).toBe(409);
  });

  it('a form cannot point at itself or make a loop', async () => {
    const list = (await (sub(tokens.admin, { code: `t_b_${run}`, name_ru: `Тест B ${run}`, name_uz: 'Test B' })).expect(200)).body;
    const a = byName(list, `Тест A ${run}`);
    const b = byName(list, `Тест B ${run}`);
    await http().patch(`/api/staff/compat/substances/${b.id}`).set(bearer(tokens.admin)).send({ kind: 'form', parent_id: a.id }).expect(200);
    expect((await http().patch(`/api/staff/compat/substances/${a.id}`).set(bearer(tokens.admin)).send({ parent_id: b.id })).body.code).toBe('BAD_PARENT');
    expect((await http().patch(`/api/staff/compat/substances/${a.id}`).set(bearer(tokens.admin)).send({ parent_id: a.id })).body.code).toBe('BAD_PARENT');
  });

  it('a rule starts as a draft; only an admin approves; a specialist edit sends it back to draft', async () => {
    const subs = (await http().get('/api/staff/compat/substances').set(bearer(tokens.admin)).expect(200)).body;
    const a = byName(subs, `Тест A ${run}`);
    const c = byName(subs, 'Витамин K2');
    const body = { substance_a_id: a.id, substance_b_id: c.id, kind: 'spread', interval_hours: 3, when_a: 'morning', when_b: 'evening', text_ru: 'Разнесите приём на 3 часа.', text_uz: 'Qabulni 3 soatga ajrating.' };
    const created = (await http().post('/api/staff/compat/rules').set(bearer(tokens.specialist)).send(body).expect(200)).body;
    const rule = created.find((r: { a: { id: string }; b: { id: string } }) => r.a.id === a.id && r.b.id === c.id);
    expect(rule).toMatchObject({ status: 'draft', origin: 'admin', kind: 'spread' });

    // the same pair in the other order is the same rule
    expect((await http().post('/api/staff/compat/rules').set(bearer(tokens.admin)).send({ ...body, substance_a_id: c.id, substance_b_id: a.id })).body.code).toBe('RULE_EXISTS');
    expect((await http().post('/api/staff/compat/rules').set(bearer(tokens.admin)).send({ ...body, substance_b_id: a.id })).body.code).toBe('SAME_SUBSTANCE');

    expect((await http().post('/api/staff/compat/rules/status').set(bearer(tokens.specialist)).send({ ids: [rule.id], status: 'approved' })).status).toBe(403);
    const approved = (await http().post('/api/staff/compat/rules/status').set(bearer(tokens.admin)).send({ ids: [rule.id], status: 'approved' }).expect(200)).body;
    expect(approved.find((r: { id: string }) => r.id === rule.id)).toMatchObject({ status: 'approved', approved_by: expect.any(String) });

    // the admin's own edit keeps it approved, the specialist's sends it back
    let list = (await http().patch(`/api/staff/compat/rules/${rule.id}`).set(bearer(tokens.admin)).send({ interval_hours: 4 }).expect(200)).body;
    expect(list.find((r: { id: string }) => r.id === rule.id)).toMatchObject({ status: 'approved', interval_hours: 4 });
    list = (await http().patch(`/api/staff/compat/rules/${rule.id}`).set(bearer(tokens.specialist)).send({ text_ru: 'Разнесите приём на 4 часа.' }).expect(200)).body;
    expect(list.find((r: { id: string }) => r.id === rule.id)).toMatchObject({ status: 'draft', approved_by: null });

    // «Выключить» is allowed to a specialist; nothing is deleted
    await http().post('/api/staff/compat/rules/status').set(bearer(tokens.specialist)).send({ ids: [rule.id], status: 'off' }).expect(200);
    expect(await prisma.compat_rules.findUnique({ where: { id: rule.id } })).toMatchObject({ status: 'off' });
    await http().post('/api/staff/compat/rules').set(bearer(tokens.manager)).send(body).expect(403);
    expect(await prisma.audit_logs.count({ where: { entity_type: 'compat_rule', entity_id: rule.id } })).toBeGreaterThanOrEqual(5);
  });

  it('substances of a product are chosen from the dictionary', async () => {
    const product = await createTestProduct(prisma, { price: 40_000, stock: 5 });
    const subs = (await http().get('/api/staff/compat/substances').set(bearer(tokens.admin)).expect(200)).body;
    const ids = [byName(subs, 'Магний').id, byName(subs, 'Витамин B6').id];
    const put = (token: string, substance_ids: string[]) => http().put(`/api/staff/compat/products/${product.id}/substances`).set(bearer(token)).send({ substance_ids });
    await put(tokens.manager, ids).expect(403);
    let list = (await put(tokens.specialist, ids).expect(200)).body;
    expect(list.find((p: { id: string }) => p.id === product.id).substances.map((s: { name_ru: string }) => s.name_ru)).toEqual(['Магний', 'Витамин B6']); // in the order given
    list = (await put(tokens.admin, [ids[0]]).expect(200)).body;
    expect(list.find((p: { id: string }) => p.id === product.id).substances).toHaveLength(1);
    expect((await put(tokens.admin, ['00000000-0000-4000-8000-000000000000']).expect(400)).body.code).toBe('BAD_SUBSTANCE');
  });
});
