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
