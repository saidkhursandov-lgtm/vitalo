import { BadRequestException, Body, Controller, HttpCode, Injectable, Logger, Param, ParseUUIDPipe, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, MaxLength } from 'class-validator';
import { memoryStorage } from 'multer';
import { EnrichService, EnrichUnavailable } from '../compat/enrich.service';
import type { EnrichPayload } from '../compat/enrich';
import { normalizeText } from '../compat/knowledge';
import { PrismaService } from '../prisma/prisma.service';
import { AdminProductsService, forViewer } from '../staff/admin-products';
import { can } from '../staff/permissions';
import { CurrentStaff, RequirePermission, StaffGuard, type StaffContext } from '../staff/staff-auth';
import { autoPrice } from './auto-price';
import { CARD_SCHEMA, CARD_SYSTEM, cardDataBlock, checkCardAnswer, type CardLists } from './iherb-card';
import { parseIherbUrl } from './iherb-fields';
import { nextIherbSku, readIherbPage, PHOTOS_MAX, variantLabel, type IherbPage } from './iherb-page';

/** The saved page with its pictures can be big; its text is what matters. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** products.markup_percent / price_round_to defaults (schema.prisma): the same rule as auto pricing. */
export const DEFAULT_MARKUP = 80;
export const DEFAULT_ROUND = 1000;
const CARD_MAX_TOKENS = 12_000;
const CARD_TIMEOUT_MS = 150_000;
/** Only the iHerb picture server: the server never downloads anything else by a link from a page. */
const PHOTO_HOST = /(^|\.)images-iherb\.com$/i;

export interface SimilarProduct {
  id: string;
  sku: string;
  name_ru: string;
  brand: string;
  status: string;
  iherb_product_id: string | null;
}

/** A substance the dictionary does not have: the model's names help to add it in one click. */
export interface UnknownSuggestion {
  name: string;
  dose: string | null;
  name_uz: string;
  synonyms: string[];
}

class PhotosDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(PHOTOS_MAX) @IsString({ each: true }) @MaxLength(500, { each: true }) urls!: string[];
}

const matchKey = (s: string) => s.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

/** The model's names of an unknown substance (the card's «actives» with the same Russian name). */
export function unknownSuggestions(unknown: EnrichPayload['unknown'], actives: { name_ru: string; name_uz: string; name_en: string }[]): UnknownSuggestion[] {
  return unknown.map((u) => {
    const key = normalizeText(u.name);
    const a = actives.find((x) => {
      const k = normalizeText(x.name_ru);
      return k === key || k.includes(key) || key.includes(k);
    });
    return { name: u.name, dose: u.dose, name_uz: a?.name_uz ?? '', synonyms: a?.name_en ? [a.name_en] : [] };
  });
}

/** A picture from the iHerb server; a redirect is followed only while it stays on that server (at most 3). */
async function fetchPhoto(start: URL): Promise<Response> {
  let u = start;
  for (let hop = 0; hop < 4; hop++) {
    if (u.protocol !== 'https:' || !PHOTO_HOST.test(u.hostname)) throw new Error(`not the iHerb picture server: ${u.hostname}`);
    const res = await fetch(u, { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      u = new URL(res.headers.get('location')!, u);
      continue;
    }
    if (!res.ok) throw new Error(`http ${res.status}`);
    if (!/^image\//i.test(res.headers.get('content-type') ?? 'image/')) throw new Error('not an image');
    return res;
  }
  throw new Error('too many redirects');
}

/** VITALO price from the iHerb price: the auto pricing rule of a new product (no purchase cost, nothing on the shelf). */
/** D-79: «120 count» → 120; the pack size part of a variant label. */
const countOf = (label: string | null) => {
  const m = /(?:^|· )([\d.,]+) count$/i.exec(label ?? '');
  return m ? Number(m[1].replace(/[.,]/g, '')) : null;
};
/** D-79: two variant labels differ only in the pack size («5000 IU · 180 count» / «5000 IU · 360 count»). */
export function onlyCountDiffers(a: string | null, b: string | null): boolean {
  if (!a || !b || countOf(a) == null || countOf(b) == null || countOf(a) === countOf(b)) return false;
  const rest = (x: string) => x.split(' · ').slice(0, -1).join(' · ');
  return rest(a) === rest(b);
}
/** D-79: the pack size in a name of the other pack size → this one («…, 120 капсул» → «…, 60 капсул»). */
export function swapCount(text: string | null, from: number, to: number): string | null {
  if (!text) return text;
  return text.replace(new RegExp(`(^|[^\\d])${from}(?=\\s*(?:капс|таб|шт|мягк|жеват|пастил|kaps|tab|dona|softgel|caps|count|veg))`, 'gi'), `$1${to}`);
}

export function priceFromIherb(iherbPrice: number, markup = DEFAULT_MARKUP, roundTo = DEFAULT_ROUND): number {
  return autoPrice({
    iherb_price_uzs: iherbPrice,
    iherb_in_stock: true,
    markup_percent: markup,
    price_round_to: roundTo,
    stock_price_mode: 'freeze',
    available: 0,
    current_price_uzs: 0,
    cost_uzs: null,
    min_markup_pct: 0,
  }).target_uzs;
}

/**
 * D-78 «Добавить из iHerb»: the saved iHerb page → a draft of the whole product (card RU + UZ, price, photos, and the
 * VITALO AI data: substances, doses, audience, goals). Nothing is written here: the person checks the draft in the
 * product editor and «Создать товар» saves it hidden (AdminProductsService.create). Then the photos are fetched.
 */
@Injectable()
export class IherbAddService {
  private readonly logger = new Logger(IherbAddService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrich: EnrichService,
    private readonly products: AdminProductsService,
  ) {}

  static inputOf(file: Express.Multer.File | undefined, text: unknown): string {
    const s = file ? file.buffer.toString('utf8') : typeof text === 'string' ? text : '';
    if (!s.trim()) throw new BadRequestException({ code: 'PAGE_EMPTY', message: 'Выберите сохранённую страницу товара iHerb или вставьте её текст' });
    return s;
  }

  private async lists(): Promise<CardLists> {
    const [cats, brands, countries, forms] = await Promise.all([
      this.prisma.categories.findMany({ where: { status: 'active', merged_into_id: null }, orderBy: [{ tree_type: 'asc' }, { sort_order: 'asc' }], select: { id: true, name_ru: true, tree_type: true } }),
      this.prisma.brands.findMany({ where: { status: 'active', is_test: false }, orderBy: { name_ru: 'asc' }, select: { name_ru: true } }),
      this.prisma.countries.findMany({ where: { status: 'active' }, select: { name_ru: true } }),
      this.prisma.forms.findMany({ where: { status: 'active' }, select: { name_ru: true } }),
    ]);
    return {
      categories: cats.map((c, i) => ({ key: `c${i + 1}`, id: c.id, name_ru: c.name_ru, tree: c.tree_type })),
      brands: brands.map((b) => b.name_ru),
      countries: countries.map((c) => c.name_ru),
      forms: forms.map((f) => f.name_ru),
    };
  }

  /** The same brand and a similar name (typo-tolerant, pg_trgm), or the same iHerb number. */
  async similar(brand: string, names: string[], iherbId: string): Promise<SimilarProduct[]> {
    const ns = names.filter((n) => n && n.trim().length >= 3).map((n) => n.toLowerCase());
    if (!ns.length) return [];
    const rows = await this.prisma.$queryRaw<(SimilarProduct & { score: number })[]>(Prisma.sql`
      SELECT id, sku, name_ru, brand, status::text AS status, iherb_product_id,
             GREATEST(${Prisma.join(ns.map((n) => Prisma.sql`similarity(lower(name_ru), ${n})`))}) AS score
      FROM products
      WHERE is_test = false
        AND (iherb_product_id = ${iherbId}
             OR (lower(brand) = ${brand.toLowerCase()} AND GREATEST(${Prisma.join(ns.map((n) => Prisma.sql`similarity(lower(name_ru), ${n})`))}) > 0.3)
             OR GREATEST(${Prisma.join(ns.map((n) => Prisma.sql`similarity(lower(name_ru), ${n})`))}) > 0.55)
      ORDER BY score DESC
      LIMIT 5`);
    return rows.map(({ score: _s, ...r }) => r);
  }

  private async dictionaryIds(card: { brand: string; manufacturer: string; country: string | null; form: string | null }) {
    const find = async (rows: { id: string; name_ru: string }[], v: string | null) => (v ? (rows.find((r) => matchKey(r.name_ru) === matchKey(v))?.id ?? null) : null);
    const active = { where: { status: 'active' as const }, select: { id: true, name_ru: true } };
    const [b, m, c, f] = await Promise.all([this.prisma.brands.findMany(active), this.prisma.manufacturers.findMany(active), this.prisma.countries.findMany(active), this.prisma.forms.findMany(active)]);
    return { brand_id: await find(b, card.brand), manufacturer_id: await find(m, card.manufacturer), country_id: await find(c, card.country), form_id: await find(f, card.form) };
  }

  /** D-79: the other pack sizes of the page that are already in the shop. */
  private async variantsInShop(page: IherbPage) {
    const pids = page.variants.map((v) => v.product_id);
    const ours = pids.length
      ? await this.prisma.products.findMany({ where: { iherb_product_id: { in: pids } }, select: { id: true, sku: true, name_ru: true, status: true, iherb_product_id: true, variant_group_id: true } })
      : [];
    const list = page.variants.map((v) => ({ ...v, label_ru: variantLabel(v.label, 'ru'), ours: ours.find((o) => o.iherb_product_id === v.product_id) ?? null }));
    const join = list.find((v) => v.ours?.variant_group_id)?.ours ?? list.find((v) => v.ours)?.ours ?? null;
    return { list, variant_of: join?.id ?? null };
  }

  /**
   * D-79: the same product in another pack size is already in the shop → its card is copied (no AI, nothing paid):
   * names get this pack size, the price, the link and the photos are this page's. Only when the two differ in the
   * pack size alone — another dose is another composition, that goes through AI.
   */
  private async copyFromVariant(me: StaffContext, link: { productId: string; url: string }, page: IherbPage, vars: { list: { label: string; ours: { id: string } | null }[] }, otherPage = false) {
    const src = vars.list.find((v) => v.ours && onlyCountDiffers(v.label, page.variant_label));
    if (!src?.ours) return null;
    const p = await this.prisma.products.findUnique({
      where: { id: src.ours.id },
      include: { categories: { select: { category_id: true } }, substances: { orderBy: { position: 'asc' }, select: { substance_id: true, in_label: true, dose_amount: true, dose_unit: true } } },
    });
    if (!p) return null;
    const from = countOf(src.label)!;
    const to = countOf(page.variant_label)!;
    const problems = [`Карточка скопирована с фасовки ${p.sku} (${variantLabel(src.label, 'ru')}) — AI не вызывался. Проверьте название, количество в банке, вес и фото.`];
    // the price of this pack size from its button; the page's own price only when the page is of this pack size
    const iherbPrice = page.variant_price_uzs ?? (otherPage ? null : page.price_uzs);
    if (otherPage) problems.push(`Сохранена страница другой фасовки (iHerb ${page.canonical_id}): цена взята с кнопки фасовки, фото не взяты — добавьте их вручную или сохраните страницу этой фасовки`);
    if (page.wrong_currency) problems.push('Страница iHerb в долларах — переключите iHerb на сумы (UZS), сохраните страницу заново, иначе цену не посчитать');
    if (!iherbPrice) problems.push('Не нашёл цену iHerb в сумах — впишите цену VITALO вручную');
    if (page.in_stock === false && !otherPage) problems.push('На iHerb товара сейчас нет в наличии');
    problems.push('Вес и размеры упаковки не скопированы — у другой фасовки они другие, впишите с iHerb');
    const skus = await this.prisma.products.findMany({ where: { sku: { startsWith: 'VTL-H', mode: 'insensitive' } }, select: { sku: true } });
    const admin = can(me.staff.role, 'costs.view');
    const n = (v: Prisma.Decimal | null) => (v == null ? null : Number(v));
    const draft = {
      sku: nextIherbSku(skus.map((x) => x.sku)),
      status: 'hidden' as const,
      name_ru: swapCount(p.name_ru, from, to)!,
      name_uz: swapCount(p.name_uz, from, to),
      short_name_ru: swapCount(p.short_name_ru, from, to),
      short_name_uz: swapCount(p.short_name_uz, from, to),
      brand: p.brand,
      manufacturer: p.manufacturer,
      country: p.country,
      form: p.form,
      brand_id: p.brand_id,
      manufacturer_id: p.manufacturer_id,
      country_id: p.country_id,
      form_id: p.form_id,
      short_description_ru: p.short_description_ru,
      short_description_uz: p.short_description_uz,
      composition_ru: p.composition_ru,
      composition_uz: p.composition_uz,
      directions_ru: p.directions_ru,
      directions_uz: p.directions_uz,
      warnings_ru: p.warnings_ru,
      warnings_uz: p.warnings_uz,
      search_keywords: p.search_keywords,
      shell_ru: p.shell_ru,
      shell_uz: p.shell_uz,
      pack_count: p.pack_count && p.pack_count !== from ? Math.round((p.pack_count * to) / from) : to,
      servings_per_day: p.servings_per_day,
      shipping_weight_g: null,
      shipping_length_mm: null,
      shipping_width_mm: null,
      shipping_height_mm: null,
      price_uzs: iherbPrice ? priceFromIherb(iherbPrice) : 0,
      category_ids: p.categories.map((c) => c.category_id),
      iherb_url: link.url,
      ...(admin && { auto_pricing_enabled: true, markup_percent: p.markup_percent, price_round_to: p.price_round_to }),
      dose_amount: n(p.dose_amount),
      dose_unit: p.dose_unit,
      dose_per: p.dose_per,
      match_form: p.match_form,
      substances: p.substances.map((x) => ({ id: x.substance_id, in_label: x.in_label, dose_amount: n(x.dose_amount), dose_unit: x.dose_unit })),
      audience: p.audience,
      goals: p.goals,
      variant_of: p.id,
      variant_label_ru: variantLabel(page.variant_label, 'ru'),
      variant_label_uz: variantLabel(page.variant_label, 'uz'),
      ai_filled: true,
    };
    return {
      duplicate: null,
      copied_from: { id: p.id, sku: p.sku, name_ru: p.name_ru },
      draft,
      photos: otherPage ? [] : page.photos,
      iherb: { product_id: link.productId, url: link.url, price_uzs: iherbPrice, price_source: iherbPrice ? ('page' as const) : null, in_stock: otherPage ? null : page.in_stock, title: page.title, iherb_code: page.iherb_code, upc: page.upc },
      variants: vars.list,
      enrichment: null,
      unknown: [],
      similar: [],
      problems,
      note: '',
      cost_usd: 0,
    };
  }

  async draft(me: StaffContext, rawUrl: string, input: string, now = new Date()) {
    const link = parseIherbUrl(rawUrl ?? '');
    if (!link) throw new BadRequestException({ code: 'BAD_IHERB_URL', message: 'Ссылка iHerb должна вести на страницу товара, например https://uz.iherb.com/pr/…/12345' });
    // the same iHerb product is already ours: show it, spend nothing on AI
    const existing = await this.prisma.products.findUnique({ where: { iherb_product_id: link.productId }, select: { id: true, sku: true, name_ru: true, brand: true, status: true, iherb_product_id: true } });
    if (existing) return { duplicate: existing };

    const page = readIherbPage(input, link.productId);
    if (page.text.length < 300) throw new BadRequestException({ code: 'PAGE_EMPTY', message: 'На странице почти нет текста — сохраните страницу товара целиком (Ctrl+S) или скопируйте весь текст (Ctrl+A, Ctrl+C)' });
    if (page.same_product === false) throw new BadRequestException({ code: 'WRONG_PAGE', message: `Сохранённая страница — не товар ${link.productId}. Откройте ссылку, которую вставили, и сохраните её` });
    // D-79: the page saved is of another pack size of the link: only a copy from a pack size in the shop can use it
    const otherPage = !!page.canonical_id && page.canonical_id !== link.productId;
    const vars = await this.variantsInShop(page);
    const copied = await this.copyFromVariant(me, link, page, vars, otherPage);
    if (copied) return copied;
    if (otherPage) throw new BadRequestException({ code: 'WRONG_PAGE', message: `Сохранённая страница — другая фасовка (iHerb ${page.canonical_id}), а не товар ${link.productId}. Откройте ссылку, которую вставили, и сохраните её` });

    const s = await this.enrich.assertCanCall(now);
    const lists = await this.lists();
    const card = await this.enrich.callLogged(
      { scenario: 'iherb_card', setKey: link.productId, model: s.card_model, system: CARD_SYSTEM, data: cardDataBlock(page.text, lists, link.url), schema: CARD_SCHEMA as never, maxTokens: CARD_MAX_TOKENS, timeoutMs: CARD_TIMEOUT_MS },
      (json) => {
        const c = checkCardAnswer(json, lists);
        return c.ok ? { ok: true, value: c } : c;
      },
    );
    if (!card.ok) throw new EnrichUnavailable(card.error === 'empty' ? 'AI_EMPTY' : 'AI_FAILED', card.error === 'empty' ? 'AI не нашёл на странице название и бренд товара' : 'AI ответил не по форме, попробуйте ещё раз');
    const c = card.value.card;
    const problems = [...card.value.problems];

    const enr = await this.enrich.draftFromTexts(
      {
        name_ru: c.name_ru,
        name_uz: c.name_uz,
        short_name_ru: c.short_name_ru,
        brand: c.brand,
        form: c.form,
        short_description_ru: c.short_description_ru,
        composition_ru: c.composition_ru,
        directions_ru: c.directions_ru,
        match_form: c.match_form,
        servings_per_day: c.servings_per_day,
        pack_count: c.pack_count,
      },
      `iherb:${link.productId}`,
      s,
    );
    const payload = enr.payload;
    if (enr.failed) problems.push('AI не смог разобрать вещества состава — выберите их вручную в блоке «Состав для VITALO AI»');
    else if (!payload) problems.push('AI не нашёл в составе действующих веществ из справочника — выберите их вручную');

    // price: the page's own data block first, the model's reading only as a fallback (then it must be checked)
    const iherbPrice = page.price_uzs ?? c.price_uzs;
    const priceSource = page.price_uzs ? 'page' : c.price_uzs ? 'ai' : null;
    if (page.wrong_currency) problems.push('Страница iHerb в долларах — переключите iHerb на сумы (UZS), сохраните страницу заново, иначе цену не посчитать');
    if (!iherbPrice) problems.push('Не нашёл цену iHerb в сумах — впишите цену VITALO вручную');
    else if (priceSource === 'ai') problems.push('Цену iHerb прочитал AI из текста — сверьте её со страницей');
    const inStock = page.in_stock ?? c.in_stock;
    if (inStock === false) problems.push('На iHerb товара сейчас нет в наличии');
    if (!page.photos.length) problems.push(page.format === 'text' ? 'Из скопированного текста фото не взять — сохраните страницу (Ctrl+S) или добавьте фото вручную' : 'На странице не нашлось фото товара — добавьте вручную');

    const skus = await this.prisma.products.findMany({ where: { sku: { startsWith: 'VTL-H', mode: 'insensitive' } }, select: { sku: true } });
    const ids = await this.dictionaryIds(c);
    const similar = (await this.similar(c.brand, [c.name_ru, page.title ?? ''], link.productId)).filter((x) => !vars.list.some((v) => v.ours?.id === x.id));
    if (page.sizes_of_other_variant) problems.push('Вес и размеры на странице iHerb могут относиться к другой фасовке — сверьте с iHerb');
    const main = payload?.substances.find((x) => x.in_label && x.dose_amount != null) ?? payload?.substances.find((x) => x.dose_amount != null) ?? null;
    const admin = can(me.staff.role, 'costs.view');

    const draft = {
      sku: nextIherbSku(skus.map((x) => x.sku)),
      status: 'hidden' as const,
      name_ru: c.name_ru,
      name_uz: c.name_uz,
      short_name_ru: c.short_name_ru?.slice(0, 60) ?? null,
      short_name_uz: c.short_name_uz?.slice(0, 60) ?? null,
      brand: c.brand,
      manufacturer: c.manufacturer,
      country: c.country,
      form: c.form,
      ...ids,
      short_description_ru: c.short_description_ru,
      short_description_uz: c.short_description_uz,
      composition_ru: c.composition_ru,
      composition_uz: c.composition_uz,
      directions_ru: c.directions_ru,
      directions_uz: c.directions_uz,
      warnings_ru: c.warnings_ru,
      warnings_uz: c.warnings_uz,
      search_keywords: c.search_keywords,
      shell_ru: c.shell_ru,
      shell_uz: c.shell_uz,
      pack_count: c.pack_count,
      servings_per_day: c.servings_per_day,
      shipping_weight_g: c.shipping_weight_g,
      shipping_length_mm: c.shipping_length_mm,
      shipping_width_mm: c.shipping_width_mm,
      shipping_height_mm: c.shipping_height_mm,
      price_uzs: iherbPrice ? priceFromIherb(iherbPrice) : 0,
      category_ids: c.category_ids,
      iherb_url: link.url,
      ...(admin && { auto_pricing_enabled: true, markup_percent: DEFAULT_MARKUP, price_round_to: DEFAULT_ROUND }),
      dose_amount: main?.dose_amount ?? null,
      dose_unit: main?.dose_unit ?? null,
      dose_per: c.dose_per,
      match_form: c.match_form,
      substances: (payload?.substances ?? []).map((x) => ({ id: x.id, in_label: x.in_label, dose_amount: x.dose_amount, dose_unit: x.dose_unit })),
      audience: payload?.audience ?? null,
      goals: payload?.goals ?? [],
      variant_of: vars.variant_of,
      variant_label_ru: variantLabel(page.variant_label, 'ru'),
      variant_label_uz: variantLabel(page.variant_label, 'uz'),
      ai_filled: true,
    };
    return {
      duplicate: null,
      draft,
      photos: page.photos,
      iherb: { product_id: link.productId, url: link.url, price_uzs: iherbPrice ?? null, price_source: priceSource, in_stock: inStock, title: page.title, iherb_code: page.iherb_code, upc: page.upc },
      variants: vars.list,
      enrichment: payload,
      unknown: payload ? unknownSuggestions(payload.unknown, c.actives) : [],
      similar,
      problems,
      note: [c.note, payload?.note].filter(Boolean).join(' '),
      cost_usd: Math.round((card.cost_usd + enr.cost_usd) * 10000) / 10000,
    };
  }

  /** Downloads the iHerb photos of a created product (only from the iHerb picture server) and adds them like an upload. */
  async addPhotos(me: StaffContext, productId: string, urls: string[]) {
    const known = new Set((await this.prisma.product_media.findMany({ where: { product_id: productId }, select: { title: true } })).map((m) => m.title));
    let added = 0;
    const failed: string[] = [];
    for (const raw of urls) {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        failed.push(raw);
        continue;
      }
      const title = `iherb:${u.pathname.split('/').slice(-3).join('/')}`;
      if (u.protocol !== 'https:' || !PHOTO_HOST.test(u.hostname)) {
        failed.push(raw);
        continue;
      }
      if (known.has(title)) continue;
      try {
        const res = await fetchPhoto(u);
        if (Number(res.headers.get('content-length') ?? 0) > MAX_PHOTO_BYTES) throw new Error('too big');
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > MAX_PHOTO_BYTES) throw new Error('too big');
        await this.products.addPhoto(me.staff.id, productId, { buffer }, title);
        known.add(title);
        added++;
      } catch (e) {
        this.logger.warn(`iHerb photo not added to ${productId}: ${u.pathname} (${e instanceof Error ? e.message : String(e)})`);
        failed.push(raw);
      }
    }
    return { added, failed, product: forViewer(me.staff.role, await this.products.get(productId)) };
  }
}

@ApiTags('staff: products')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/products')
export class IherbAddController {
  constructor(private readonly svc: IherbAddService) {}

  /** «Добавить из iHerb»: the link + the saved page (file) or its text → a draft of the product. Nothing is saved. */
  @Post('iherb/draft')
  @HttpCode(200)
  @RequirePermission('products.edit')
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({ schema: { type: 'object', properties: { url: { type: 'string' }, file: { type: 'string', format: 'binary' }, text: { type: 'string' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  draft(@CurrentStaff() me: StaffContext, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: { url?: unknown; text?: unknown }) {
    return this.svc.draft(me, typeof body?.url === 'string' ? body.url : '', IherbAddService.inputOf(file, body?.text));
  }

  /** After «Создать товар»: the photos of the draft, downloaded from the iHerb picture server. */
  @Post(':id/photos/iherb')
  @HttpCode(200)
  @RequirePermission('products.edit')
  photos(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PhotosDto) {
    return this.svc.addPhotos(me, id, dto.urls);
  }
}
