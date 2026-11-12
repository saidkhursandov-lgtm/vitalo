/**
 * Шаг 0в: сравнение моделей для «Вопроса по корзине» (D-69). 10 корзин из настоящих товаров vitalo_dev × RU/UZ ×
 * Haiku/Sonnet, тот же промпт, схема и проверка ответа, что в AiGoalService. Пишет JSON в путь из аргумента.
 *
 * Только чтение: база должна оканчиваться на _dev, соединение одно и в режиме default_transaction_read_only.
 * Таблицы goal_evidence в vitalo_dev ещё нет — вместо неё ПРИМЕРНЫЕ строки ниже (не одобрены врачом, только для теста).
 * Запуск: npx ts-node scripts/ai-model-compare.ts <out.json>
 */
import { config } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { SYSTEM_COMMON, costUsd } from '../src/compat/ai';
import { AnthropicModel, AiCallError } from '../src/compat/ai-client';
import { GOAL_SCHEMA, SYSTEM_GOAL, checkGoalAnswer, goalDataBlock, type Duration, type Goal } from '../src/compat/ai-goal';
import { AiGoalService } from '../src/compat/ai-goal.service';

config({ path: process.env.VITALO_ENV ?? resolve(__dirname, '../../../../../../apps/api/.env'), quiet: true } as never);
const url = process.env.DATABASE_URL ?? '';
const dbName = new URL(url).pathname.slice(1);
if (!dbName.endsWith('_dev')) throw new Error(`Only a *_dev database, got «${dbName}»`);
if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('No ANTHROPIC_API_KEY');
const u = new URL(url);
u.searchParams.set('connection_limit', '1');

const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'];
const BUDGET = 1;

/** Примерные строки «вещество → цель» (уровень, когда помогает, когда нет). НЕ одобрены врачом. */
const SAMPLE: { substance: string; goal: Goal; level: 'A' | 'B' | 'C'; helps_ru: string; helps_uz: string; not_ru: string; not_uz: string }[] = [
  { substance: 'Магний', goal: 'sleep', level: 'B', helps_ru: 'если мешают напряжение или судороги, при нехватке магния', helps_uz: 'zoʻriqish yoki tutqanoq xalaqit bersa, magniy yetishmasa', not_ru: 'не снотворное, при бессоннице от боли или кофе мало поможет', not_uz: 'uyqu dori emas, ogʻriq yoki qahva sabab boʻlsa kam yordam beradi' },
  { substance: 'Магний', goal: 'stress', level: 'C', helps_ru: 'может немного снизить напряжение при нехватке магния', helps_uz: 'magniy yetishmasa zoʻriqishni biroz kamaytirishi mumkin', not_ru: 'не заменяет отдых и помощь специалиста', not_uz: 'dam olish va mutaxassis yordamining oʻrnini bosmaydi' },
  { substance: 'Ашваганда', goal: 'stress', level: 'B', helps_ru: 'при постоянном напряжении, курс от 6–8 недель', helps_uz: 'doimiy zoʻriqishda, 6–8 haftadan kurs', not_ru: 'не действует сразу, не для острой тревоги', not_uz: 'darhol taʼsir qilmaydi, oʻtkir xavotir uchun emas' },
  { substance: 'Витамины группы B', goal: 'stress', level: 'C', helps_ru: 'при нехватке в питании', helps_uz: 'ovqatda yetishmasa', not_ru: 'при обычном питании эффект небольшой', not_uz: 'oddiy ovqatlanishda taʼsiri kichik' },
  { substance: 'Витамин B12', goal: 'energy', level: 'B', helps_ru: 'если его не хватает (вегетарианское питание, возраст)', helps_uz: 'yetishmasa (vegetarian ovqat, yosh)', not_ru: 'при нормальном уровне бодрости не прибавит', not_uz: 'darajasi normal boʻlsa tetiklik qoʻshmaydi' },
  { substance: 'Железо', goal: 'energy', level: 'A', helps_ru: 'только при подтверждённой нехватке железа', helps_uz: 'faqat temir yetishmasligi tasdiqlansa', not_ru: 'без анализа не принимать долго', not_uz: 'tahlilsiz uzoq ichmang' },
  { substance: 'Витамин D3', goal: 'immunity', level: 'B', helps_ru: 'при нехватке витамина D, особенно зимой', helps_uz: 'D vitamini yetishmasa, ayniqsa qishda', not_ru: 'при нормальном уровне пользы мало', not_uz: 'darajasi normal boʻlsa foydasi kam' },
  { substance: 'Витамин C', goal: 'immunity', level: 'B', helps_ru: 'может немного сократить простуду при регулярном приёме', helps_uz: 'muntazam ichilsa shamollashni biroz qisqartirishi mumkin', not_ru: 'простуду полностью не предотвращает', not_uz: 'shamollashning oldini toʻliq olmaydi' },
  { substance: 'Цинк', goal: 'immunity', level: 'B', helps_ru: 'в первые дни простуды, коротким курсом', helps_uz: 'shamollashning birinchi kunlarida, qisqa kurs', not_ru: 'долго в больших дозах не принимать', not_uz: 'uzoq vaqt katta dozada ichmang' },
  { substance: 'Глюкозамин', goal: 'joints', level: 'C', helps_ru: 'у части людей уменьшает скованность за 2–3 месяца', helps_uz: 'baʼzilarda 2–3 oyda qotishni kamaytiradi', not_ru: 'при острой боли или травме не поможет', not_uz: 'oʻtkir ogʻriq yoki jarohatda yordam bermaydi' },
  { substance: 'Коллаген', goal: 'joints', level: 'C', helps_ru: 'для поддержки при нагрузках, курс 3 месяца', helps_uz: 'yuklamada qoʻllab-quvvatlash uchun, 3 oylik kurs', not_ru: 'данных немного, быстрого эффекта нет', not_uz: 'maʼlumot kam, tez taʼsir yoʻq' },
  { substance: 'Омега-3', goal: 'joints', level: 'C', helps_ru: 'может немного уменьшить утреннюю скованность', helps_uz: 'ertalabki qotishni biroz kamaytirishi mumkin', not_ru: 'не заменяет визит к врачу', not_uz: 'shifokorga borishning oʻrnini bosmaydi' },
  { substance: 'Креатин', goal: 'sport', level: 'A', helps_ru: 'сила и мощность в коротких нагрузках', helps_uz: 'qisqa yuklamalarda kuch va quvvat', not_ru: 'на выносливость в длинных нагрузках влияет мало', not_uz: 'uzoq yuklamada chidamlilikka kam taʼsir qiladi' },
  { substance: 'Протеин', goal: 'sport', level: 'A', helps_ru: 'если белка в питании мало', helps_uz: 'ovqatda oqsil kam boʻlsa', not_ru: 'при достаточном белке в еде не нужен', not_uz: 'ovqatda oqsil yetarli boʻlsa kerak emas' },
  { substance: 'Электролиты', goal: 'sport', level: 'B', helps_ru: 'при долгих тренировках и жаре', helps_uz: 'uzoq mashgʻulot va issiqda', not_ru: 'при коротких тренировках не нужны', not_uz: 'qisqa mashgʻulotda kerak emas' },
];

/** 10 корзин: вещества (по одному товару на каждое) и выбранные чипы. В некоторые нарочно добавлен лишний товар. */
const CARTS: { goal: Goal; duration: Duration; kind: string; subs: string[] }[] = [
  { goal: 'sleep', duration: '2to4w', kind: 'fall_asleep', subs: ['Магний', 'Витамин B6'] },
  { goal: 'sleep', duration: 'gt1m', kind: 'wake_night', subs: ['Магний L-Треонат', 'Витамин D3', 'Биотин'] },
  { goal: 'stress', duration: '2to4w', kind: 'tension', subs: ['Ашваганда', 'Магний', 'Витамины группы B'] },
  { goal: 'stress', duration: 'lt2w', kind: 'irritability', subs: ['Омега-3', 'Витамин B6'] },
  { goal: 'energy', duration: 'gt1m', kind: 'afternoon', subs: ['Витамин B12', 'Железо', 'Витамин D3'] },
  { goal: 'energy', duration: '2to4w', kind: 'morning', subs: ['Коэнзим Q10', 'Мультивитаминный комплекс', 'Гиалуроновая кислота'] },
  { goal: 'joints', duration: 'gt1m', kind: 'stiffness', subs: ['Глюкозамин', 'Коллаген', 'Омега-3'] },
  { goal: 'joints', duration: '2to4w', kind: 'after_load', subs: ['UC-II (неденатурированный коллаген II типа)', 'МСМ'] },
  { goal: 'immunity', duration: 'lt2w', kind: 'season', subs: ['Витамин C', 'Цинк', 'Витамин D3', 'Лютеин'] },
  { goal: 'sport', duration: '2to4w', kind: 'strength', subs: ['Креатин', 'Протеин', 'Электролиты'] },
];

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('Usage: ai-model-compare.ts <out.json>');
  const prisma = new PrismaClient({ datasourceUrl: u.toString() });
  await prisma.$executeRawUnsafe('SET default_transaction_read_only = on');
  const subs = await prisma.substances.findMany({ where: { enabled: true }, select: { id: true, name_ru: true } });
  const subId = new Map(subs.map((s) => [s.name_ru, s.id]));
  let sampleGoal: Goal = 'sleep';
  const fakePrisma = new Proxy(prisma, {
    get(t, k) {
      if (k === 'goal_evidence')
        return {
          findMany: async () =>
            SAMPLE.filter((r) => r.goal === sampleGoal && subId.has(r.substance)).map((r) => ({
              substance_id: subId.get(r.substance)!,
              level: r.level,
              helps_ru: r.helps_ru,
              helps_uz: r.helps_uz,
              not_helps_ru: r.not_ru,
              not_helps_uz: r.not_uz,
            })),
        };
      return (t as never)[k];
    },
  });
  const service = new AiGoalService(fakePrisma as never, null as never, null as never, null as never, null as never);
  const model = new AnthropicModel();
  const results: unknown[] = [];
  let spent = 0;

  for (const [i, c] of CARTS.entries()) {
    const items = [];
    for (const s of c.subs) {
      const p = await prisma.products.findFirst({
        where: { status: 'active', substances: { some: { substance_id: subId.get(s) } } },
        orderBy: { sku: 'asc' },
        select: { id: true, sku: true, name_ru: true, name_uz: true },
      });
      if (p && items.some((x) => x.product_id === p.id)) console.log(`cart ${i + 1}: ${s} is in the same product`);
      else if (p) items.push({ product_id: p.id, sku: p.sku, name_ru: p.name_ru, name_uz: p.name_uz ?? p.name_ru });
      else console.log(`cart ${i + 1}: no product for ${s}`);
    }
    sampleGoal = c.goal;
    for (const lang of ['ru', 'uz'] as const) {
      const { data } = await service.goalData(items, lang, c.goal, c.duration, c.kind);
      for (const m of MODELS) {
        if (spent > BUDGET * 0.9) throw new Error(`Budget nearly spent: $${spent.toFixed(3)}`);
        const started = Date.now();
        let row: Record<string, unknown> = { cart: i + 1, goal: c.goal, duration: c.duration, kind: c.kind, lang, model: m, products: data.cart.map((p) => ({ ref: p.ref, name: p.name, levels: p.evidence.map((e) => e.level) })) };
        try {
          const r = await model.complete({ model: m, system: `${SYSTEM_COMMON}\n\n${SYSTEM_GOAL}`, data: goalDataBlock(data), schema: GOAL_SCHEMA, maxTokens: 2000 });
          const cost = costUsd(m, r.inputTokens, r.outputTokens);
          spent += cost;
          const checked = r.outcome === 'ok' ? checkGoalAnswer(r.json, data) : { ok: false as const, error: r.outcome };
          row = { ...row, latency_ms: Date.now() - started, input_tokens: r.inputTokens, output_tokens: r.outputTokens, cost, ok: checked.ok, error: checked.ok ? null : checked.error, json: r.json };
        } catch (e) {
          row = { ...row, latency_ms: Date.now() - started, ok: false, error: e instanceof AiCallError ? e.code : String(e), cost: 0 };
        }
        results.push(row);
        console.log(`cart ${i + 1} ${lang} ${m}: ${row.ok ? 'ok' : `FAIL ${row.error}`} ${row.latency_ms} ms, total $${spent.toFixed(4)}`);
      }
    }
  }
  writeFileSync(out, JSON.stringify({ spent, results }, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
