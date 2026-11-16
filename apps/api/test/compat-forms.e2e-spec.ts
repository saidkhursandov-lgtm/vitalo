import { INestApplication } from '@nestjs/common';
import { applyFormsPlan, buildFormsPlan, rollbackFormsPlan, targetSubstances, type FormsInput } from '../src/compat/forms-load';
import { PrismaService } from '../src/prisma/prisma.service';
import { archiveTestProducts, createTestApp, createTestProduct } from './helpers';

/** `npm run compat:forms`: new forms, synonyms, labels; apply with backup and rollback. */
describe('compat:forms loader (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const code = `e2e_form_${Date.now()}`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await archiveTestProducts(prisma);
    await app.close();
  });

  it('targetSubstances: replace, remove, label first in label order', () => {
    expect(targetSubstances(['magnesium', 'b6', 'bcaa'], { label: ['b6', 'mg_cit'], replace: { magnesium: 'mg_cit' }, remove: ['bcaa'] })).toEqual([
      { code: 'b6', in_label: true },
      { code: 'mg_cit', in_label: true },
    ]);
    expect(targetSubstances(['a', 'b'], { label: [] })).toEqual([
      { code: 'a', in_label: false },
      { code: 'b', in_label: false },
    ]);
  });

  it('check writes nothing; apply makes the form, the label and the synonyms; a second run changes nothing; rollback restores', async () => {
    const mg = await prisma.substances.findFirstOrThrow({ where: { name_ru: 'Магний' } });
    const b6 = await prisma.substances.findFirstOrThrow({ where: { name_ru: 'Витамин B6' } });
    const product = await createTestProduct(prisma, { price: 50_000, stock: 1 });
    await prisma.products.update({ where: { id: product.id }, data: { substance_form_ru: 'цитрат магния', substance_form_uz: 'sitrat' } });
    await prisma.product_substances.createMany({ data: [{ product_id: product.id, substance_id: mg.id }, { product_id: product.id, substance_id: b6.id, position: 1 }] });
    const synBefore = mg.synonyms;

    const input: FormsInput = {
      substances: [{ code, kind: 'form', parent: mg.code, name_ru: 'Цитрат магния E2E', name_uz: 'Magniy sitrat E2E', synonyms: ['цитрат магния e2e'] }],
      synonyms: [{ code: mg.code, add: ['magnesium e2e'] }],
      products: { [product.sku]: { label: [code, b6.code], replace: { [mg.code]: code } }, 'NO-SUCH-SKU': { label: [] } },
    };
    const plan = await buildFormsPlan(prisma, input);
    expect(plan.errors).toEqual([]);
    expect(plan.create.map((s) => s.code)).toEqual([code]);
    expect(plan.missing).toEqual(['NO-SUCH-SKU']);
    expect(plan.products[0]).toMatchObject({ sku: product.sku, labelBefore: 'цитрат магния', labelRu: 'Цитрат магния E2E + Витамин B6' });
    expect(await prisma.substances.count({ where: { code } })).toBe(0);

    const r = await applyFormsPlan(prisma, plan);
    expect(r).toMatchObject({ created: 1, synonyms: 1, products: 1 });
    const p = await prisma.products.findUniqueOrThrow({ where: { id: product.id }, include: { substances: { orderBy: { position: 'asc' }, include: { substance: true } } } });
    expect(p.substance_form_ru).toBe('Цитрат магния E2E + Витамин B6');
    expect(p.substance_form_uz).toMatch(/^Magniy sitrat E2E \+ /);
    expect(p.substances.map((s) => [s.substance.code, s.in_label])).toEqual([[code, true], [b6.code, true]]);
    expect((await prisma.substances.findFirstOrThrow({ where: { code } })).parent_id).toBe(mg.id);
    expect((await prisma.substances.findUniqueOrThrow({ where: { id: mg.id } })).synonyms).toContain('magnesium e2e');

    const again = await buildFormsPlan(prisma, input);
    expect(again).toMatchObject({ create: [], synonyms: [], products: [], unchanged: [product.sku] });

    await rollbackFormsPlan(prisma);
    const back = await prisma.products.findUniqueOrThrow({ where: { id: product.id }, include: { substances: { orderBy: { position: 'asc' } } } });
    expect(back.substance_form_ru).toBe('цитрат магния');
    expect(back.substance_form_uz).toBe('sitrat');
    expect(back.substances.map((s) => s.substance_id)).toEqual([mg.id, b6.id]);
    expect((await prisma.substances.findUniqueOrThrow({ where: { id: mg.id } })).synonyms).toEqual(synBefore);
    expect((await prisma.substances.findFirstOrThrow({ where: { code } })).enabled).toBe(false);
    await expect(rollbackFormsPlan(prisma)).rejects.toThrow(/Резервных таблиц/);
  });
});
