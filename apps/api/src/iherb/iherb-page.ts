/**
 * «Добавить из iHerb» (D-78): the owner opens an iHerb product page in his own browser and gives us the saved page
 * (Ctrl+S) or its copied text. As with the wishlist (wishlist-parser.ts), we never visit iHerb ourselves: no robots,
 * no bypassing of bot protection. This file reads the page (no database, no network) — the service and the tests use it.
 *
 * What a program can read reliably comes from the page's own data block (JSON-LD «Product»: name, brand, price in sum,
 * stock, photos); the texts of the card are drafted by the model (iherb-card.ts) and always checked by a person.
 */
import { decode, sumsIn } from './wishlist-parser';

export interface IherbPage {
  format: 'html' | 'text';
  /** The visible text of the page, lines kept, for the model. */
  text: string;
  title: string | null;
  brand: string | null;
  /** The price a customer pays on iHerb, sum (from the page's data block); null — not found or not in sum. */
  price_uzs: number | null;
  in_stock: boolean | null;
  /** The page shows dollars (or another currency): iHerb must be switched to sum before saving. */
  wrong_currency: boolean;
  /** Photo links of this product on the iHerb picture server, large size, main first. */
  photos: string[];
  /** iHerb's own code of the product («NOW-00733») and UPC — shown to the person, help to find the same product. */
  iherb_code: string | null;
  upc: string | null;
  /** The saved page is the page of this product (the link number is on it); null — cannot tell (copied text). */
  same_product: boolean | null;
  /**
   * D-79: the other pack sizes / doses iHerb offers (the «Package quantity» / «Potency» buttons), this product excluded.
   * `label` — what this button means for the product of the link, e.g. «5000 IU · 360 count».
   */
  variants: IherbVariant[];
  /** D-79: the label of the product of the link itself among those buttons; null — the page has no such buttons. */
  variant_label: string | null;
  /**
   * D-79: the weight and size block of the saved page belongs to another pack size (iHerb fills it for the size shown
   * first, not always the one of the link) — they must be checked.
   */
  sizes_of_other_variant: boolean;
  /** D-79: the iHerb number of the page itself (its canonical link); the page may be another pack size of the link. */
  canonical_id: string | null;
  /** D-79: the iHerb price of the link's own pack size from its button, sum (the same on the page of any pack size). */
  variant_price_uzs: number | null;
}

export interface IherbVariant {
  product_id: string;
  label: string;
  price_uzs: number | null;
  url: string | null;
}

interface Tile {
  val: string;
  pid: string;
  url: string | null;
  selected: boolean;
  price: number | null;
}

/** «180 count» buttons are the pack size, the rest (IU, mcg, flavour…) the dose/kind — two independent choices. */
const isCount = (v: string) => /\bcount\b/i.test(v);

function variantTiles(html: string): Tile[] {
  const out: Tile[] = [];
  const re = /<div\b[^>]*class="attribute-tile(?:\s[^"]*)?"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  for (let m; (m = re.exec(html)); ) {
    const tag = /^<div\b[^>]*>/.exec(m[0])![0];
    const attr = (n: string) => new RegExp(`\\s${n}="([^"]*)"`).exec(tag)?.[1] ?? null;
    const val = attr('data-val');
    const pid = attr('data-pid');
    if (!val || !pid || !/^\d+$/.test(pid)) continue;
    const body = decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
    const sum = sumsIn(body, [])[0];
    out.push({ val: decode(val).trim(), pid, url: attr('data-url'), selected: attr('aria-selected') === 'true' || /\bselected\b/.test(attr('class') ?? ''), price: sum ? Math.round(sum.value) : null });
  }
  return out;
}

/**
 * D-79: the variant buttons → labels. Within one choice (pack size, or dose) the button of the link's product is its
 * value; when the link's product is not among the buttons of a choice, it has the value selected on the page (iHerb
 * shows the pack sizes of the selected dose).
 */
export function readVariants(html: string, productId: string): { variants: IherbVariant[]; label: string | null; price_uzs: number | null } {
  const tiles = variantTiles(html);
  if (!tiles.length) return { variants: [], label: null, price_uzs: null };
  const groups = [tiles.filter((t) => !isCount(t.val)), tiles.filter((t) => isCount(t.val))].filter((g) => g.length > 1);
  if (!groups.length) return { variants: [], label: null, price_uzs: null };
  const own = groups.map((g) => (g.find((t) => t.pid === productId) ?? g.find((t) => t.selected) ?? null)?.val ?? null);
  const label = own.every(Boolean) ? own.join(' · ') : null;
  const variants: IherbVariant[] = [];
  const seen = new Set([productId]);
  // pack sizes first: they are of the selected dose, so their label is exact; a dose button leads to that dose in
  // some pack size iHerb picks — its label is the dose alone
  const counts = groups.length === 2 ? 1 : isCount(groups[0][0].val) ? 0 : -1;
  for (const gi of [counts, ...groups.keys()].filter((i, k, a) => i >= 0 && a.indexOf(i) === k)) {
    for (const t of groups[gi]) {
      if (seen.has(t.pid)) continue;
      seen.add(t.pid);
      const lbl = gi === counts ? own.map((v, i) => (i === gi ? t.val : v)).filter(Boolean).join(' · ') : t.val;
      variants.push({ product_id: t.pid, label: lbl, price_uzs: t.price, url: t.url });
    }
  }
  return { variants, label, price_uzs: tiles.find((t) => t.pid === productId && t.price)?.price ?? null };
}

/** D-79: an iHerb button value in the shop's words: «180 count» → «180 шт» / «180 dona», «5000 IU» → «5000 МЕ» / «5000 XB». */
export function variantLabel(v: string | null, lang: 'ru' | 'uz'): string | null {
  if (!v) return null;
  return v
    .split(' · ')
    .map((p) =>
      p
        .replace(/^([\d.,]+)\s*count$/i, lang === 'ru' ? '$1 шт' : '$1 dona')
        .replace(/\bIU\b/g, lang === 'ru' ? 'МЕ' : 'XB')
        .replace(/\bmcg\b/gi, lang === 'ru' ? 'мкг' : 'mkg')
        .replace(/\bmg\b/gi, lang === 'ru' ? 'мг' : 'mg'),
    )
    .join(' · ')
    .slice(0, 40);
}

/** The text the model reads: enough for the card, the composition and the label (the reviews below are cut). */
export const PAGE_TEXT_MAX = 40_000;
export const PHOTOS_MAX = 8;

const BLOCK = /^(p|div|li|ul|ol|br|tr|td|th|h[1-6]|section|article|header|footer|table|dt|dd|dl|main|aside|nav|form|label|button)$/i;

/** HTML → visible text, one block per line (scripts, styles and pictures dropped). */
export function htmlToText(html: string): string {
  const src = html.replace(/<(script|style|svg|noscript|template|head)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const withBreaks = src.replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (_m, name: string) => (BLOCK.test(name) ? '\n' : ' '));
  return decode(withBreaks)
    .split('\n')
    .map((l) => l.replace(/[ \t  ]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .filter((l, i, a) => l !== a[i - 1])
    .join('\n');
}

type Json = Record<string, unknown>;

/** Every JSON-LD object of the page (arrays and @graph opened). */
export function jsonLdObjects(html: string): Json[] {
  const out: Json[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      out.push(v as Json);
      if (Array.isArray((v as Json)['@graph'])) walk((v as Json)['@graph']);
    }
  };
  for (let m = re.exec(html); m; m = re.exec(html)) {
    try {
      walk(JSON.parse(decode(m[1].trim())));
    } catch {
      /* a broken block is skipped */
    }
  }
  return out;
}

const isType = (o: Json, t: string) => (Array.isArray(o['@type']) ? (o['@type'] as unknown[]).includes(t) : o['@type'] === t);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const nameOf = (v: unknown): string | null => (v && typeof v === 'object' ? str((v as Json).name) : str(v));

const IMG = /https?:\/\/(?:[a-z0-9-]+\.)?images-iherb\.com\/[^\s"'<>()\\]+?\.(?:jpe?g|png|webp)/gi;
/** «…/images/now/now00733/l/50.jpg» → folder «now/now00733», size «l», file «50.jpg». */
const IMG_PARTS = /\/([a-z0-9-]+\/[a-z0-9-]+)\/([a-z]{1,2})\/([^/]+)$/i;

/** iHerb picture links of one product: only those in the main photo's folder, large size, one per file, main first. */
export function productPhotos(html: string, main: string[]): string[] {
  const all = [...main, ...(html.match(IMG) ?? [])].map((u) => u.replace(/&amp;/g, '&'));
  const first = all.map((u) => IMG_PARTS.exec(u.split('?')[0])).find(Boolean);
  if (!first) return [];
  const folder = first[1].toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of all) {
    const clean = u.split('?')[0];
    const p = IMG_PARTS.exec(clean);
    if (!p || p[1].toLowerCase() !== folder) continue;
    const file = p[3].toLowerCase();
    if (seen.has(file)) continue;
    seen.add(file);
    // the large picture of the same file (a gallery keeps small «s» / «t» ones)
    out.push(clean.replace(IMG_PARTS, `/${p[1]}/l/${p[3]}`));
    if (out.length >= PHOTOS_MAX) break;
  }
  return out;
}

const DOLLARS = /(?:\$\s?\d|\d\s?\$|\bUSD\b)/;

/** «Веб-страница, один файл» (.mhtml): the HTML part of the archive, decoded; null — not such an archive. */
export function fromMhtml(s: string): string | null {
  const head = s.slice(0, 4000);
  if (!/^MIME-Version:/im.test(head) || !/multipart\/related/i.test(head)) return null;
  const b = /boundary="?([^"\r\n;]+)"?/i.exec(head);
  if (!b) return null;
  for (const part of s.split(`--${b[1]}`)) {
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const headers = part.slice(0, split);
    if (!/Content-Type:\s*text\/html/i.test(headers)) continue;
    let body = part.slice(split).replace(/^\r?\n\r?\n/, '');
    if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(headers)) {
      body = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
    } else if (/Content-Transfer-Encoding:\s*base64/i.test(headers)) {
      body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    }
    return body;
  }
  return null;
}

/** Reads a saved iHerb product page (HTML or .mhtml) or its copied text. `productId` — the number of the link the person gave. */
export function readIherbPage(raw: string, productId: string): IherbPage {
  const input = fromMhtml(raw) ?? raw;
  const isHtml = /<html[\s>]|<body[\s>]|<div[\s>]|<script[\s>]/i.test(input);
  const text = (isHtml ? htmlToText(input) : input.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()).slice(0, PAGE_TEXT_MAX);
  const page: IherbPage = {
    format: isHtml ? 'html' : 'text',
    text,
    title: null,
    brand: null,
    price_uzs: null,
    in_stock: null,
    wrong_currency: false,
    photos: [],
    iherb_code: null,
    upc: null,
    same_product: null,
    variants: [],
    variant_label: null,
    sizes_of_other_variant: false,
    canonical_id: null,
    variant_price_uzs: null,
  };
  if (isHtml) {
    const product = jsonLdObjects(input).find((o) => isType(o, 'Product'));
    if (product) {
      page.title = str(product.name);
      page.brand = nameOf(product.brand);
      page.iherb_code = str(product.sku) ?? str(product.mpn);
      page.upc = str(product.gtin12) ?? str(product.gtin13) ?? str(product.gtin);
      const offers = (Array.isArray(product.offers) ? product.offers : [product.offers]).filter((o): o is Json => !!o && typeof o === 'object');
      const offer = offers.find((o) => /^(uzs|sum|so'm)$/i.test(str(o.priceCurrency) ?? '')) ?? offers[0];
      if (offer) {
        const cur = (str(offer.priceCurrency) ?? '').toUpperCase();
        const price = Number(String(offer.price ?? offer.lowPrice ?? '').replace(/[^\d.]/g, ''));
        if (cur === 'UZS' && Number.isFinite(price) && price >= 1000) page.price_uzs = Math.round(price);
        else if (cur && cur !== 'UZS') page.wrong_currency = true;
        const av = str(offer.availability) ?? '';
        if (av) page.in_stock = /instock|limitedavailability|preorder/i.test(av);
      }
      const imgs = (Array.isArray(product.image) ? product.image : [product.image]).map(str).filter((x): x is string => !!x);
      page.photos = productPhotos(input, imgs);
    }
    if (!page.photos.length) {
      const og = /<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(input);
      page.photos = productPhotos(input, og ? [og[1]] : []);
    }
    if (!page.title) page.title = str(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(input)?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') ?? null);
    const v = readVariants(input, productId);
    page.variants = v.variants;
    page.variant_label = v.label;
    page.variant_price_uzs = v.price_uzs;
    page.canonical_id = /<link\b[^>]*rel="canonical"[^>]*href="[^"]*\/pr\/[^"]*?\/(\d+)(?:[?#"])/.exec(input)?.[1] ?? null;
    const modelPid = /\bid="modelProperties"[^>]*\bdata-product-id="(\d+)"/.exec(input)?.[1] ?? /\bdata-product-id="(\d+)"[^>]*\bid="modelProperties"/.exec(input)?.[1];
    page.sizes_of_other_variant = !!modelPid && modelPid !== productId && /data-shipping-weight-kg|data-dimensions-cm/.test(input);
    page.same_product = new RegExp(`/pr/(?:[^"'/?#\\s]+/)?${productId}(?![0-9])`).test(input);
  }
  if (!page.price_uzs && !page.wrong_currency && DOLLARS.test(text.slice(0, 6000)) && !sumsIn(text.slice(0, 6000), []).length) page.wrong_currency = true;
  return page;
}

/** The next free iHerb SKU: VTL-H001, VTL-H002 … (the owner's rule, 09.11.2026). */
export function nextIherbSku(skus: string[]): string {
  const max = skus.reduce((m, s) => {
    const x = /^VTL-H(\d+)$/i.exec(s);
    return x ? Math.max(m, Number(x[1])) : m;
  }, 0);
  return `VTL-H${String(max + 1).padStart(3, '0')}`;
}
