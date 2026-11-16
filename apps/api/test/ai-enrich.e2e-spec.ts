import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AI_MODEL, type AiCompletion, type AiModel } from '../src/compat/ai-client';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, bearer, createTestApp, createTestProduct, DEV_MANAGER_TG, loginStaff } from './helpers';

const ADMIN_TG = 222_222_221;

class FakeModel implements AiModel {
  calls: { system: string; data: string }[] = [];
  reply: (data: string) => unknown = () => ({});
  ready() {
    return true;
  }
  async complete(input: { system: string; data: string }): Promise<AiCompletion> {
    this.calls.push(input);
    return { json: this.reply(input.data), inputTokens: 2000, outputTokens: 200, outcome: 'ok' };
  }
}

/** VITALO AI, ветка 1: drafts of a product card, «Принять», the time and the meal of a rule, the RU → UZ button. */
describe('VITALO AI enrichment of a product card (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const fake = new FakeModel();
  const tokens: Record<string, string> = {};
  const run = Date.now().toString(36);
  const http = () => request(app.getHttpServer());
  const s: Record<string, string> = {};
  const code = (k: string) => `en_${k}_${run}`;

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(AI_MODEL).useValue(fake));
    prisma = app.get(PrismaService);
    await prisma.settings.deleteMany({ where: { key: 'vitalo_ai' } });
    tokens.admin = await loginStaff(app, ADMIN_TG);
    tokens.manager = await loginStaff(app, DEV_MANAGER_TG);
    s.mg = (await prisma.substances.create({ data: { code: code('mg'), name_ru: `Магний ${run}`, name_uz: `Magniy ${run}`, synonyms: [] } })).id;
    s.mgc = (await prisma.substances.create({ data: { code: code('mgc'), kind: 'form', parent_id: s.mg, name_ru: `Магний цитрат ${run}`, name_uz: `Magniy sitrat ${run}`, synonyms: [] } })).id;
    s.b6 = (await prisma.substances.create({ data: { code: code('b6'), name_ru: `B6 ${run}`, name_uz: `B6 ${run}`, synonyms: [] } })).id;
  });

  afterAll(async () => {
    await prisma.settings.deleteMany({ where: { key: 'vitalo_ai' } });
    await prisma.compat_rules.updateMany({ where: { substance_a_id: { in: Object.values(s) } }, data: { status: 'off' } });
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('«Заполнить с помощью AI» makes a draft; «Принять» merges it without losing the hand-made label; a manager cannot', async () => {
    const product = await createTestProduct(prisma, { price: 90_000, stock: 3, name: `Магний цитрат + B6 ${run}` });
    await prisma.product_substances.create({ data: { product_id: product.id, substance_id: s.mg, in_label: true } });
    fake.reply = (data) => {
      expect(data).toContain(`Название: Магний цитрат + B6 ${run}`);
      expect(data).toContain(`- ${code('mgc')} | Магний цитрат ${run} | форма вещества ${code('mg')}`);
      return {
        substances: [
          { code: code('mgc'), dose_amount: 200, dose_unit: 'mg', in_label: true },
          { code: code('b6'), dose_amount: 5, dose_unit: 'mg', in_label: true },
          { code: 'made_up_code', dose_amount: 1, dose_unit: 'mg', in_label: false },
        ],
        unknown: [{ name: 'Таурин', dose: null }],
        audience: 'adult',
        goals: ['sleep', 'stress'],
        note: '',
      };
    };

    await http().post(`/api/staff/compat/products/${product.id}/enrich`).set(bearer(tokens.manager)).expect(403);
    const draft = await http().post(`/api/staff/compat/products/${product.id}/enrich`).set(bearer(tokens.admin)).expect(200);
    expect(draft.body.payload.substances.map((x: { id: string }) => x.id)).toEqual([s.mgc, s.b6]);
    expect(draft.body.payload.unknown).toEqual([{ name: 'Таурин', dose: null }]);
    const log = await prisma.ai_requests.findFirstOrThrow({ where: { scenario: 'enrich', set_key: product.id } });
    expect(log.status).toBe('ok');

    // nothing changed yet; the card shows the draft
    expect(await prisma.product_substances.count({ where: { product_id: product.id } })).toBe(1);
    const card = await http().get(`/api/staff/products/${product.id}`).set(bearer(tokens.admin)).expect(200);
    expect(card.body.enrichment.id).toBe(draft.body.id);

    const list = await http().get('/api/staff/compat/enrichments').set(bearer(tokens.admin)).expect(200);
    expect(list.body.drafts.some((d: { id: string }) => d.id === draft.body.id)).toBe(true);

    await http().post('/api/staff/compat/enrichments/accept').set(bearer(tokens.admin)).send({ ids: [draft.body.id] }).expect(200);
    const subs = await prisma.product_substances.findMany({ where: { product_id: product.id }, orderBy: { position: 'asc' } });
    // the form replaced «Магний» and took its label mark; B6 was not in the label before → not marked now
    expect(subs.map((x) => [x.substance_id, x.in_label, Number(x.dose_amount), x.dose_unit])).toEqual([
      [s.mgc, true, 200, 'mg'],
      [s.b6, false, 5, 'mg'],
    ]);
    const after = await prisma.products.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.audience).toBe('adult');
    expect(after.goals).toEqual(['sleep', 'stress']);
    expect(after.substance_form_ru).toBe(`Магний цитрат ${run}`);
    expect((await prisma.product_enrichments.findUniqueOrThrow({ where: { id: draft.body.id } })).status).toBe('accepted');
  });

  it('the card saves doses, audience and goals and accepts its draft with the same save', async () => {
    const product = await createTestProduct(prisma, { price: 50_000, stock: 2, name: `B6 ${run}` });
    fake.reply = () => ({ substances: [{ code: code('b6'), dose_amount: 10, dose_unit: 'mg', in_label: true }], unknown: [], audience: 'any', goals: ['energy'], note: '' });
    const draft = await http().post(`/api/staff/compat/products/${product.id}/enrich`).set(bearer(tokens.admin)).expect(200);
    const saved = await http()
      .patch(`/api/staff/products/${product.id}`)
      .set(bearer(tokens.admin))
      .send({ substances: [{ id: s.b6, in_label: true, dose_amount: 12.5, dose_unit: 'mg' }], audience: 'child', goals: ['energy', 'immunity'], enrichment_id: draft.body.id })
      .expect(200);
    expect(saved.body.substances[0]).toMatchObject({ id: s.b6, dose_amount: 12.5, dose_unit: 'mg' });
    expect(saved.body).toMatchObject({ audience: 'child', goals: ['energy', 'immunity'], enrichment: null });
    expect((await prisma.product_enrichments.findUniqueOrThrow({ where: { id: draft.body.id } })).status).toBe('accepted');
    await http().patch(`/api/staff/products/${product.id}`).set(bearer(tokens.admin)).send({ goals: ['magic'] }).expect(400);
  });

  it('an answer without known substances is refused and logged; a switched-off AI makes no draft', async () => {
    const product = await createTestProduct(prisma, { price: 10_000, stock: 1, name: `Пусто ${run}` });
    fake.reply = () => ({ substances: [{ code: 'nope', dose_amount: null, dose_unit: null, in_label: false }], unknown: [], audience: 'any', goals: [], note: '' });
    const r = await http().post(`/api/staff/compat/products/${product.id}/enrich`).set(bearer(tokens.admin)).expect(409);
    expect(r.body.code).toBe('AI_EMPTY');
    expect((await prisma.ai_requests.findFirstOrThrow({ where: { scenario: 'enrich', set_key: product.id } })).status).toBe('invalid');

    await prisma.settings.upsert({ where: { key: 'vitalo_ai' }, create: { key: 'vitalo_ai', value: { enabled: false } }, update: { value: { enabled: false } } });
    const off = await http().post(`/api/staff/compat/products/${product.id}/enrich`).set(bearer(tokens.admin)).expect(409);
    expect(off.body.code).toBe('AI_DISABLED');
    await prisma.settings.deleteMany({ where: { key: 'vitalo_ai' } });
  });

  it('a rule keeps the time of day and the meal apart; the old field follows', async () => {
    const r = await http()
      .post('/api/staff/compat/rules')
      .set(bearer(tokens.admin))
      .send({ substance_a_id: s.mgc, substance_b_id: s.b6, kind: 'synergy', time_a: 'evening', meal_a: 'any', time_b: 'morning', meal_b: 'with_fat', text_ru: 'Магний и B6 дополняют друг друга.', text_uz: 'Magniy va B6 bir-birini toʻldiradi.' })
      .expect(200);
    const rule = r.body.find((x: { a: { id: string }; b: { id: string } }) => x.a.id === s.mgc && x.b.id === s.b6);
    expect(rule).toMatchObject({ time_a: 'evening', meal_a: 'any', time_b: 'morning', meal_b: 'with_fat', when_a: 'evening', when_b: 'morning' });
    const long = 'Длинное объяснение. '.repeat(50);
    await http().patch(`/api/staff/compat/rules/${rule.id}`).set(bearer(tokens.admin)).send({ meal_b: 'empty_stomach', text_ru: long }).expect(200);
    const row = await prisma.compat_rules.findUniqueOrThrow({ where: { id: rule.id } });
    expect(row).toMatchObject({ time_b: 'morning', meal_b: 'empty_stomach', when_b: 'morning', text_ru: long.trim() });
  });

  it('«Перевести на узбекский» returns Latin Uzbek and refuses Cyrillic', async () => {
    fake.reply = () => ({ text: 'Magniy kechqurun qabul qilinadi.' });
    const ok = await http().post('/api/staff/compat/translate').set(bearer(tokens.admin)).send({ text: 'Магний принимают вечером.' }).expect(200);
    expect(ok.body.text).toBe('Magniy kechqurun qabul qilinadi.');
    fake.reply = () => ({ text: 'Магний кечкурун.' });
    const bad = await http().post('/api/staff/compat/translate').set(bearer(tokens.admin)).send({ text: 'Магний принимают вечером.' }).expect(502);
    expect(bad.body.code).toBe('AI_FAILED');
  });
});
