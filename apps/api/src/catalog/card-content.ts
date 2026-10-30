/**
 * 2.3: product card content from docs/content/VITALO_content.xlsx («Товары», columns J–Z) → the database.
 * Only the 2.3 card fields are written (plus the photo-check fixes below); needs, types, prices and stock are not touched.
 *
 *   plan     — rows are matched to products like in 2.2 (content-sheet.ts); Halal / VEGE by D-32, soft wording by D-33;
 *   apply    — one transaction: backup tables card_backup_<stamp>_*, then the fields;
 *   rollback — the latest backup back in place.
 *
 * The Excel file itself is never changed: the softened texts exist only in the database.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { buildContentPlan, ContentSheet, DbBrand, DbCategory, DbProduct, SheetCard, SheetProduct } from './content-sheet';

export const VERDICT_MAX = 400;
export const MARKET_MAX = 50;

/** Rows skipped in 2.2 because of a pack mismatch; the photo check (release-2.3.md) ties them to these products. */
export const CARD_MAP: Record<string, string> = {
  'VM-DUO-120': 'OZN-A004',
  'VM-COLL-CAPS': 'OZN-A005',
  'MP-COLL-90': 'OZN-A013',
};

const RECHECK = 'сверить при следующей поставке';

/** Photo check 30.10.2026: where the photo is clear — the count and the name; where not — only a staff note. */
export const PHOTO_FIXES: Record<string, { short_ru?: string; short_uz?: string; pack_count?: number; servings_per_day?: null; shell_ru?: string; shell_uz?: string; note?: string }> = {
  'OZN-A004': { short_ru: 'Набор Мультивитаминов Duo, 2×60 капс.', short_uz: 'Multivitamin toʻplami Duo, 2×60 kaps.', pack_count: 120 },
  'OZN-A005': {
    short_ru: 'Коллаген + Гиалурон и Вит C, 120 капс.',
    short_uz: 'Kollagen + Gialuron va Vit C, 120 kaps.',
    pack_count: 120,
    servings_per_day: null,
    note: `На фото 120 капсул, на этикетке «в 6 капсулах», в таблице 3 капсулы в день — ${RECHECK}: сколько капсул в день.`,
  },
  'OZN-A013': {
    short_ru: 'Коллаген + Вит C, 120 капс.',
    short_uz: 'Kollagen + Vit C, 120 kaps.',
    pack_count: 120,
    shell_ru: 'желатиновая капсула',
    shell_uz: 'jelatin kapsula',
    note: `На фото 120 капсул (в таблице было «таб., 90»). Вид желатина и порций в день — ${RECHECK}.`,
  },
  'OZN-A022': { note: `Фото такое же, как у OZN-A014 (180 таблеток), в названии 200 — ${RECHECK}: 180 или 200 таблеток, нужно своё фото.` },
};

/** D-33: «было → стало». Exact pieces of the sheet texts; a piece that is not found is reported, never guessed. */
export interface SoftenRule {
  kind: 'product' | 'brand';
  key: string; // sheet SKU or brand name in the sheet
  field: 'verdict_ru' | 'verdict_uz' | 'memo_ru' | 'memo_uz' | 'why_ru' | 'why_uz';
  from: string;
  to: string;
}

export const SOFTEN: SoftenRule[] = [
  { kind: 'brand', key: 'NOW Foods', field: 'why_ru', from: 'Мировой эталон нутрицевтики с 1968 года (США).', to: 'Американский производитель нутрицевтиков с 1968 года.' },
  {
    kind: 'brand',
    key: 'NOW Foods',
    field: 'why_ru',
    from: 'Собственные аналитические лаборатории (ICP-MS, ВЭЖХ) и строгая сертификация GMP гарантируют 100% соответствие дозировок на этикетке и отсутствие тяжелых металлов.',
    to: 'Собственный лабораторный контроль (ICP-MS, ВЭЖХ), в том числе на тяжёлые металлы, и производство по стандартам GMP.',
  },
  { kind: 'brand', key: 'NOW Foods', field: 'why_uz', from: '1968-yildan beri nutrisevtika boʻyicha jahon etaloni (AQSH).', to: '1968-yildan beri nutrisevtika ishlab chiqaruvchi Amerika brendi.' },
  {
    kind: 'brand',
    key: 'NOW Foods',
    field: 'why_uz',
    from: 'Oʻz analitik laboratoriyalari va qatʼiy GMP sertifikati yorliqdagi dozalarning 100% mosligini hamda ogʻir metallar yoʻqligini kafolatlaydi.',
    to: 'Oʻz laboratoriya nazorati, jumladan ogʻir metallarga tekshiruv, va GMP standartlari boʻyicha ishlab chiqarish.',
  },
  { kind: 'brand', key: 'OVER', field: 'why_ru', from: 'выверенные профилактические дозировки', to: 'выверенные дозировки на каждый день' },
  { kind: 'brand', key: 'OVER', field: 'why_uz', from: 'aniq profilaktik dozalari', to: 'har kunlik aniq dozalari' },

  { kind: 'product', key: 'NOW-1294', field: 'verdict_ru', from: 'Полная клиническая дозировка элементарного магния (400 мг в 3 веганских капсулах) от американского лидера NOW Foods.', to: 'Суточная порция элементарного магния (400 мг в 3 веганских капсулах) от американского бренда NOW Foods.' },
  { kind: 'product', key: 'NOW-1294', field: 'verdict_ru', from: 'расслабляет гладкую мускулатуру сосудов, защищает от стресса и мигреней.', to: 'помогает мышцам расслабиться и поддерживает нервную систему при стрессе.' },
  { kind: 'product', key: 'NOW-1294', field: 'verdict_uz', from: 'AQSH yetakchisi NOW Foods dan 3 ta vegan kapsulada 400 mg toʻliq klinik dozadagi magniy sitrat.', to: 'AQShning NOW Foods brendidan 3 ta vegan kapsulada 400 mg magniyning kunlik porsiyasi.' },
  { kind: 'product', key: 'NOW-1294', field: 'verdict_uz', from: 'Qon tomirlari va mushaklarni boʻshashtiradi, stress hamda bosh ogʻriqlaridan himoya qiladi.', to: 'Mushaklarning boʻshashishiga yordam beradi va stressda asab tizimini qoʻllab-quvvatlaydi.' },

  {
    kind: 'product',
    key: 'OST-D3K2-VEGE-120',
    field: 'verdict_ru',
    from: 'Золотой медицинский стандарт приема витамина D3 в высокой дозировке: кофактор K2 в самой активной форме MK-7 (из ферментированного натто) направляет кальций строго в костную ткань, защищая сосуды от кальцификации.',
    to: 'Витамин D3 в высокой дозировке вместе с K2 в форме MK-7 (из ферментированного натто): K2 помогает направлять кальций в костную ткань.',
  },
  { kind: 'product', key: 'OST-D3K2-VEGE-120', field: 'verdict_ru', from: '100% веганская капсула.', to: 'Растительная капсула.' },
  {
    kind: 'product',
    key: 'OST-D3K2-VEGE-120',
    field: 'verdict_uz',
    from: 'Yuqori dozali D3 qabul qilishning oltin tibbiy standarti: K2 vitamini (MK-7 Natto shakli) kalsiyni qon tomirlariga emas, toʻgʻri suyak toʻqimasiga yoʻnaltiradi.',
    to: 'Yuqori dozali D3 vitamini K2 bilan birga (MK-7, natto shakli): K2 kalsiyni suyak toʻqimasiga yoʻnaltirishga yordam beradi.',
  },
  { kind: 'product', key: 'OST-D3K2-VEGE-120', field: 'verdict_uz', from: '100% oʻsimlik kapsulasi (VEGE).', to: 'Oʻsimlik kapsulasi.' },

  { kind: 'product', key: 'OST-CREAT-300', field: 'verdict_ru', from: 'Добавка №1 в мире по уровню клинической доказанности в спортивной медицине.', to: 'Одна из самых изученных добавок в спортивной медицине.' },
  {
    kind: 'product',
    key: 'OST-CREAT-300',
    field: 'verdict_ru',
    from: 'ускоряет ресинтез АТФ в мышцах и мозге, повышая взрывную силу, выносливость и когнитивный тонус.',
    to: 'помогает восстановлению АТФ в мышцах и поддерживает силу и выносливость на тренировках.',
  },
  { kind: 'product', key: 'OST-CREAT-300', field: 'verdict_uz', from: 'Sport tibbiyotida klinik isbotlanganlik darajasi boʻyicha №1 qoʻshimcha.', to: 'Sport tibbiyotida eng koʻp oʻrganilgan qoʻshimchalardan biri.' },
  {
    kind: 'product',
    key: 'OST-CREAT-300',
    field: 'verdict_uz',
    from: 'Mushaklar va miyada ATF tiklanishini tezlashtiradi, jismoniy kuch, chidamlilik va aqliy faollikni oshiradi.',
    to: 'Mushaklarda ATF tiklanishiga yordam beradi, mashgʻulotlarda kuch va chidamlilikni qoʻllab-quvvatlaydi.',
  },

  { kind: 'product', key: 'MP-MAGB6-200', field: 'verdict_ru', from: 'усваивается в разы лучше дешевого аптечного оксида и не раздражает желудок', to: 'усваивается значительно лучше оксида магния и мягче для желудка' },
  {
    kind: 'product',
    key: 'MP-MAGB6-200',
    field: 'verdict_ru',
    from: 'помогая снять мышечные зажимы, вечернюю тревожность и улучшить глубину сна',
    to: 'помогая мышцам расслабиться, спокойнее провести вечер и поддержать качество сна',
  },
  { kind: 'product', key: 'MP-MAGB6-200', field: 'verdict_uz', from: 'arzon dorixona oksidiga qaraganda ancha yaxshi oʻzlashtiriladi va oshqozonni bezovta qilmaydi', to: 'magniy oksidiga qaraganda ancha yaxshi oʻzlashtiriladi va oshqozon uchun yumshoqroq' },
  {
    kind: 'product',
    key: 'MP-MAGB6-200',
    field: 'verdict_uz',
    // also fixes the Cyrillic «спаз» inside the Latin text
    from: 'mushak спазmlarini, kechki xavotirni kamaytirishga va uyqu sifatini yaxshilashga yordam beradi',
    to: 'mushaklarni boʻshashtirishga, kechqurun xotirjam boʻlishga va uyqu sifatini qoʻllab-quvvatlashga yordam beradi',
  },

  { kind: 'product', key: 'MP-COLL-90', field: 'verdict_ru', from: 'профилактики хруста в суставах при тренировках', to: 'поддержки суставов при тренировках' },
  { kind: 'product', key: 'MP-COLL-90', field: 'verdict_uz', from: 'mashgʻulotlarda boʻgʻim qirsillashining oldini olish', to: 'mashgʻulotlarda boʻgʻimlarni qoʻllab-quvvatlash' },

  { kind: 'product', key: 'OV-VITC-60', field: 'verdict_ru', from: 'Укрепляет стенки сосудов и защищает иммунитет в сезон простуд.', to: 'Поддерживает сосуды и иммунитет в сезон простуд.' },
  { kind: 'product', key: 'OV-VITC-60', field: 'verdict_uz', from: 'Qon tomir devorlarini va immunitetni mustahkamlaydi.', to: 'Qon tomirlari va immunitetni qoʻllab-quvvatlaydi.' },

  {
    kind: 'product',
    key: 'VM-MARCOLL-150',
    field: 'verdict_ru',
    from: 'отличается максимальной скоростью всасывания и высокой тропностью к коже, сосудам и связкам',
    to: 'хорошо усваивается и подходит для поддержки кожи и связок',
  },
  { kind: 'product', key: 'VM-MARCOLL-150', field: 'verdict_ru', from: 'полноценную клиническую порцию (5000 мг)', to: 'полную суточную порцию (5000 мг)' },
  { kind: 'product', key: 'VM-MARCOLL-150', field: 'verdict_uz', from: 'eng yuqori soʻrilish tezligi bilan ajralib turadi', to: 'yaxshi oʻzlashtiriladi' },
  { kind: 'product', key: 'VM-MARCOLL-150', field: 'verdict_uz', from: 'toʻlaqonli 5000 mg klinik porsiyani', to: '5000 mg kunlik porsiyani' },

  // a Cyrillic word inside the Uzbek Latin text
  { kind: 'product', key: 'VM-DUO-120', field: 'memo_uz', from: 'Har куни', to: 'Har kuni' },
];

/** Words that should not be left in customer texts (D-33); a hit is a warning in the plan, the owner decides. */
export const RISKY = /(леч[иау]|излеч|гарант|100\s?%|№\s?1|золот|защищ|мигрен|кальцификац|профилакт|предотвращ|избав|устраня|исцел|без побочн|клиническ|davola|kafolat|himoya|oldini ol|profilakt|klinik)/i;

// ---------- Halal / VEGE (D-32) ----------

export type HalalVege = 'halal' | 'vege' | 'halal_vege' | 'none' | 'unknown';
const DOUBT = /уточн|сверить|сверьте|провер/i;
/** Halal: only with a certificate, cited from the label, the maker's site or the certificate itself. */
const HALAL_PROOF = /(сертифик|halal|халял)/i;
const HALAL_PLACE = /(этикет|сайт|сертифик)/i;
/** VEGE: only from the label. */
const VEGE_PLACE = /(этикет|маркировк|на банке)/i;

export function halalVegeRule(raw: string | null, source: string | null): { value: HalalVege | null; why: string | null } {
  if (!raw) return { value: null, why: null };
  const v = raw.trim().toLowerCase();
  if (v === 'нет') return { value: 'none', why: null };
  if (v === 'не знаю') return { value: 'unknown', why: null };
  const wantHalal = v.includes('halal');
  const wantVege = v.includes('vege');
  if (!wantHalal && !wantVege) return { value: 'unknown', why: `непонятное значение «${raw}»` };
  const src = source ?? '';
  const doubt = DOUBT.test(src);
  const halal = wantHalal && !doubt && HALAL_PROOF.test(src) && HALAL_PLACE.test(src);
  const vege = wantVege && !doubt && VEGE_PLACE.test(src);
  const value: HalalVege = halal && vege ? 'halal_vege' : halal ? 'halal' : vege ? 'vege' : 'unknown';
  const lost = [wantHalal && !halal && 'Halal — нет сертификата', wantVege && !vege && 'VEGE — не с этикетки'].filter(Boolean);
  return { value, why: lost.length ? `было «${raw}»: ${lost.join(', ')}` : null };
}

/** «Оболочка: …» — RU from the sheet, UZ from this list; «Не знаю» means no line. */
const SHELL_UZ: Record<string, string> = {
  'говяжий желатин': 'mol jelatini',
  'без капсулы': 'kapsulasiz',
  'растительная (hpmc)': 'oʻsimlik kapsulasi (HPMC)',
  'рыбий желатин': 'baliq jelatini',
  'желатиновая капсула': 'jelatin kapsula',
};

export function shellRule(raw: string | null): { ru: string | null; uz: string | null } {
  if (!raw || /^не знаю$/i.test(raw.trim())) return { ru: null, uz: null };
  const ru = raw.trim();
  return { ru: ru.charAt(0).toLowerCase() + ru.slice(1), uz: SHELL_UZ[ru.toLowerCase()] ?? null };
}

// ---------- plan ----------

export const CARD_FIELDS = [
  'short_name_ru',
  'short_name_uz',
  'substance_form_ru',
  'substance_form_uz',
  'pack_count',
  'servings_per_day',
  'std_bioavailability',
  'std_tested',
  'std_original',
  'halal_vege',
  'shell_ru',
  'shell_uz',
  'halal_vege_source',
  'market_advantage_percent',
  'doctor_verdict_ru',
  'doctor_verdict_uz',
  'intake_memo_ru',
  'intake_memo_uz',
  'admin_note',
] as const;
export type CardField = (typeof CARD_FIELDS)[number];
export type CardData = { [K in CardField]?: string | number | boolean | null };

export interface CardUpdate {
  product: DbProduct;
  sheet: SheetProduct;
  data: CardData;
  halalNote: string | null;
  photoFix: boolean;
}
export interface BrandSoftening {
  brand: DbBrand;
  why_ru: string | null;
  why_uz: string | null;
}
export interface Softened {
  key: string;
  field: SoftenRule['field'];
  from: string;
  to: string;
}
export interface CardPlan {
  products: CardUpdate[];
  brands: BrandSoftening[];
  softened: Softened[];
  errors: { sku: string; row: number; text: string }[];
  warnings: string[];
}

const yes = (s: string | null) => !!s && /^да$/i.test(s.trim());
function int(s: string | null, label: string, problems: string[], min: number, max: number): number | null {
  if (!s) return null;
  const n = Number(s.replace(',', '.'));
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${label}: «${s}» — нужно целое число ${min}–${max}`);
    return null;
  }
  return n;
}

function soften(text: string | null, kind: SoftenRule['kind'], key: string, field: SoftenRule['field'], plan: CardPlan): string | null {
  if (!text) return text;
  let out = text;
  for (const r of SOFTEN.filter((x) => x.kind === kind && x.key === key && x.field === field)) {
    if (out.includes(r.from)) {
      out = out.replace(r.from, r.to);
      plan.softened.push({ key, field, from: r.from, to: r.to });
    } else plan.warnings.push(`${key}, ${field}: фраза для смягчения не найдена — «${r.from.slice(0, 60)}…»`);
  }
  return out;
}

export function buildCardPlan(
  sheet: ContentSheet,
  db: { brands: DbBrand[]; products: DbProduct[]; categories: DbCategory[] },
  opts: { skip?: string[]; map?: Record<string, string> } = {},
): CardPlan {
  const plan: CardPlan = { products: [], brands: [], softened: [], errors: [], warnings: [] };
  // matching as in 2.2; its need / type problems do not matter here, only «which product is this row»
  const matched = buildContentPlan(sheet, db, { skip: opts.skip, map: { ...CARD_MAP, ...opts.map } });
  for (const e of matched.errors) plan.errors.push(e);
  for (const p of matched.notFound) plan.warnings.push(`${p.sku} (строка ${p.row}): товара нет в базе — пропущен`);

  for (const { product, sheet: row } of matched.products) {
    const c: SheetCard | undefined = row.card;
    if (!c) continue;
    const problems: string[] = [];
    const fix = PHOTO_FIXES[product.sku];
    const data: CardData = {
      substance_form_ru: c.substance_ru,
      substance_form_uz: c.substance_uz,
      pack_count: int(c.pack, 'Количество в банке', problems, 1, 10000),
      servings_per_day: int(c.per_day, 'Порций в день', problems, 1, 50),
      std_bioavailability: yes(c.std_bio),
      std_tested: yes(c.std_tested),
      std_original: yes(c.std_original),
      halal_vege_source: c.source,
      market_advantage_percent: int(c.market, 'Выгоднее Маркета', problems, 0, MARKET_MAX) || null,
      doctor_verdict_ru: soften(c.verdict_ru, 'product', row.sku, 'verdict_ru', plan),
      doctor_verdict_uz: soften(c.verdict_uz, 'product', row.sku, 'verdict_uz', plan),
      intake_memo_ru: soften(c.memo_ru, 'product', row.sku, 'memo_ru', plan),
      intake_memo_uz: soften(c.memo_uz, 'product', row.sku, 'memo_uz', plan),
    };
    const hv = halalVegeRule(c.halal_vege, c.source);
    data.halal_vege = hv.value;
    const shell = shellRule(c.shell);
    data.shell_ru = shell.ru;
    data.shell_uz = shell.uz;
    if (shell.ru && !shell.uz) plan.warnings.push(`${row.sku}: нет перевода оболочки «${shell.ru}» на узбекский — строка будет только по-русски`);
    if (fix) {
      if (fix.short_ru) data.short_name_ru = fix.short_ru;
      if (fix.short_uz) data.short_name_uz = fix.short_uz;
      if (fix.pack_count) data.pack_count = fix.pack_count;
      if (fix.servings_per_day === null) data.servings_per_day = null;
      if (fix.shell_ru) data.shell_ru = fix.shell_ru;
      if (fix.shell_uz) data.shell_uz = fix.shell_uz;
      if (fix.note) data.admin_note = fix.note;
    }
    for (const [label, text] of [['RU', data.doctor_verdict_ru], ['UZ', data.doctor_verdict_uz]] as const)
      if (typeof text === 'string' && text.length > VERDICT_MAX) problems.push(`вердикт ${label} длиннее ${VERDICT_MAX} знаков (${text.length})`);
    for (const [label, text] of [['вердикт RU', data.doctor_verdict_ru], ['вердикт UZ', data.doctor_verdict_uz], ['памятка RU', data.intake_memo_ru], ['памятка UZ', data.intake_memo_uz]] as const) {
      const hit = typeof text === 'string' ? RISKY.exec(text) : null;
      if (hit) plan.warnings.push(`${row.sku}, ${label}: осталось «${hit[0]}» — проверьте формулировку`);
    }
    if (problems.length) {
      plan.errors.push({ sku: row.sku, row: row.row, text: problems.join('; ') });
      continue;
    }
    plan.products.push({ product, sheet: row, data, halalNote: hv.why, photoFix: !!fix });
  }
  // a photo note for a product the sheet does not cover
  for (const [sku, fix] of Object.entries(PHOTO_FIXES)) {
    if (plan.products.some((u) => u.product.sku === sku)) continue;
    const product = db.products.find((p) => p.sku === sku);
    if (product && fix.note) plan.warnings.push(`${sku}: строки в таблице нет — комментарий «сверить» не запишется`);
  }

  for (const b of matched.brands) {
    const why_ru = soften(b.sheet.why_ru, 'brand', b.sheet.dbName, 'why_ru', plan);
    const why_uz = soften(b.sheet.why_uz, 'brand', b.sheet.dbName, 'why_uz', plan);
    if (why_ru !== b.sheet.why_ru || why_uz !== b.sheet.why_uz) plan.brands.push({ brand: b.brand, why_ru, why_uz });
    for (const [label, text] of [['RU', why_ru], ['UZ', why_uz]] as const) {
      const hit = text ? RISKY.exec(text) : null;
      if (hit) plan.warnings.push(`Бренд ${b.sheet.dbName}, «Почему» ${label}: осталось «${hit[0]}» — проверьте формулировку`);
    }
  }
  return plan;
}

const HV_LABEL: Record<HalalVege, string> = { halal: 'Halal', vege: 'VEGE', halal_vege: 'Halal и VEGE', none: 'Нет', unknown: 'Не знаю' };

export function formatCardPlan(plan: CardPlan): string {
  const esc = (s: unknown) => (s == null || s === '' ? '—' : String(s)).replace(/\|/g, '/').replace(/\n/g, ' ');
  const days = (d: CardData) => (d.pack_count && d.servings_per_day ? Math.floor(Number(d.pack_count) / Number(d.servings_per_day)) : null);
  const out: string[] = [];
  out.push(`### Карточки товаров: обновится ${plan.products.length}\n`);
  out.push('| Строка | Артикул в файле | Товар | Форма вещества RU | В банке / в день → дней | Стандарт | Halal / VEGE | Оболочка | Маркет, % | Вердикт RU / UZ, знаков |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const u of plan.products) {
    const d = u.data;
    const n = days(d);
    const std = [d.std_bioavailability && 'биодост.', d.std_tested && 'состав', d.std_original && 'оригинал'].filter(Boolean).join(', ');
    out.push(
      `| ${u.sheet.row} | ${esc(u.sheet.sku)} | ${u.product.sku} | ${esc(d.substance_form_ru)} | ${esc(d.pack_count)} / ${esc(d.servings_per_day)} → ${n == null ? '—' : n < 7 ? `${n} (меньше 7, не покажется)` : n} | ${std || '—'} | ${d.halal_vege ? HV_LABEL[d.halal_vege as HalalVege] : '—'}${u.halalNote ? ` (${u.halalNote})` : ''} | ${esc(d.shell_ru)} | ${esc(d.market_advantage_percent)} | ${String(d.doctor_verdict_ru ?? '').length} / ${String(d.doctor_verdict_uz ?? '').length} |`,
    );
  }
  const fixes = plan.products.filter((u) => u.photoFix);
  if (fixes.length) {
    out.push('\n### Правки по фото\n');
    out.push('| Товар | Короткое название RU / UZ | В банке | Комментарий сотрудникам |');
    out.push('| --- | --- | --- | --- |');
    for (const u of fixes) out.push(`| ${u.product.sku} | ${esc(u.data.short_name_ru)} / ${esc(u.data.short_name_uz)} | ${esc(u.data.pack_count)} | ${esc(u.data.admin_note)} |`);
  }
  if (plan.brands.length) out.push(`\n### Бренды: «Почему в VITALO» смягчается у ${plan.brands.map((b) => b.brand.name_ru).join(', ')}`);
  if (plan.softened.length) {
    out.push('\n### Смягчение текстов: было → стало\n');
    out.push('| Где | Было | Стало |');
    out.push('| --- | --- | --- |');
    for (const s of plan.softened) out.push(`| ${esc(s.key)}, ${s.field} | ${esc(s.from)} | ${esc(s.to)} |`);
  }
  if (plan.errors.length) out.push('\n**Ошибки (эти строки не загружаются):**\n\n' + plan.errors.map((e) => `- строка ${e.row}, ${e.sku}: ${e.text}`).join('\n'));
  if (plan.warnings.length) out.push('\nПредупреждения:\n\n' + plan.warnings.map((w) => `- ${w}`).join('\n'));
  return out.join('\n');
}

// ---------- apply / rollback ----------

const BACKUP_PREFIX = 'card_backup_';
const quoted = CARD_FIELDS.map((f) => `"${f}"`).join(', ');

async function backupStamps(db: PrismaClient | Prisma.TransactionClient): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name ~ '^${BACKUP_PREFIX}[0-9]{14}_products$'`,
  );
  return rows.map((r) => r.table_name.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 14)).sort();
}

export async function applyCardContent(db: PrismaClient, plan: CardPlan): Promise<{ backup: string; products: number; brands: number }> {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const t = (name: string) => `"${BACKUP_PREFIX}${stamp}_${name}"`;
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`CREATE TABLE ${t('products')} AS SELECT "id", ${quoted} FROM "products"`);
      await tx.$executeRawUnsafe(`CREATE TABLE ${t('brands')} AS SELECT "id", "why_vitalo_ru", "why_vitalo_uz" FROM "brands"`);
      for (const u of plan.products) await tx.products.update({ where: { id: u.product.id }, data: u.data as Prisma.productsUpdateInput });
      for (const b of plan.brands) await tx.brands.update({ where: { id: b.brand.id }, data: { why_vitalo_ru: b.why_ru, why_vitalo_uz: b.why_uz } });
      return { backup: `${BACKUP_PREFIX}${stamp}_*`, products: plan.products.length, brands: plan.brands.length };
    },
    { timeout: 60_000 },
  );
}

export async function rollbackCardContent(db: PrismaClient): Promise<{ backup: string; products: number; brands: number }> {
  return db.$transaction(
    async (tx) => {
      const stamp = (await backupStamps(tx)).pop();
      if (!stamp) throw new Error('Резервных таблиц card_backup_* нет: загрузка не выполнялась или уже откатана.');
      const t = (name: string) => `"${BACKUP_PREFIX}${stamp}_${name}"`;
      const set = CARD_FIELDS.map((f) => `"${f}" = k."${f}"`).join(', ');
      const products = await tx.$executeRawUnsafe(`UPDATE "products" p SET ${set} FROM ${t('products')} k WHERE k."id" = p."id"`);
      const brands = await tx.$executeRawUnsafe(
        `UPDATE "brands" b SET "why_vitalo_ru" = k."why_vitalo_ru", "why_vitalo_uz" = k."why_vitalo_uz" FROM ${t('brands')} k WHERE k."id" = b."id"`,
      );
      // kept (renamed), never dropped: the next rollback takes the backup before this one
      for (const name of ['products', 'brands']) await tx.$executeRawUnsafe(`ALTER TABLE ${t(name)} RENAME TO "card_rb_${stamp}_${name}"`);
      return { backup: `${BACKUP_PREFIX}${stamp}_*`, products, brands };
    },
    { timeout: 60_000 },
  );
}
