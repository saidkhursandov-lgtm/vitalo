/**
 * Генплан, этап 5, ветка iherb-2-prices (D-57, источник «Б»): the owner opens the iHerb wishlist in a browser and
 * gives us either the saved page (Ctrl+S, «Веб-страница полностью») or a simple table (link or number + price per line).
 * We never visit iHerb ourselves: no robots, no password, no bypassing bot protection.
 *
 * The page layout of iHerb is not ours and may change any day, so the result is always shown to the owner as a
 * preview before anything is saved, and a product we are not sure about is reported, never guessed.
 */

export interface WishlistItem {
  iherb_product_id: string;
  title: string | null;
  /** The price a customer pays on iHerb now, in sum. */
  price_uzs: number;
  /** The crossed-out price, when iHerb shows a discount. */
  list_price_uzs: number | null;
  in_stock: boolean;
  bestseller: boolean;
  /** The place in the iHerb best-seller list («#3 Best Seller», «№ 3», «место 3»), when the page or table shows it. */
  bestseller_rank: number | null;
  weight_kg: number | null;
}

export interface WishlistParse {
  format: 'html' | 'table';
  items: WishlistItem[];
  /** Products / lines we could not read (shown to the owner as is). */
  problems: string[];
  /** The page shows prices in another currency (dollars): no exchange rate is used (П2 removed), the owner switches iHerb to sum. */
  wrong_currency: boolean;
}

export const WISHLIST_MAX_ITEMS = 1000;

/** /pr/<slug>/<number> or /pr/<number>, with or without the iHerb host. */
const PRODUCT_HREF = /href\s*=\s*["']((?:https?:)?(?:\/\/(?:[a-z]{2}\.|www\.)?iherb\.com)?\/pr\/(?:[^"'/?#]+\/)?(\d{2,10}))(?:[/?#][^"']*)?["']/gi;
const PRODUCT_LINK_IN_TEXT = /(?:https?:\/\/)?(?:[a-z]{2}\.|www\.)?iherb\.com\/pr\/(?:[^\s/?#]+\/)?(\d{2,10})(?:[/?#][^\s;|]*)?/i;
/** 123 456 сум, 123,456 UZS, 123.456 so'm, UZS 123 456, 123456 сўм; a ",00" tail is tiyin. */
const NUM = String.raw`(\d{1,3}(?:[   .,]\d{3})+|\d{3,})(?:[.,]\d{1,2}(?!\d))?`;
const CUR = String.raw`(?:сум|сўм|so['ʻ’\`]?m|uzs)`;
const PRICE_AFTER = new RegExp(NUM + String.raw`\s*` + CUR, 'gi');
const PRICE_BEFORE = new RegExp(CUR + String.raw`\s*` + NUM, 'gi');
const DOLLARS = /(?:\$\s?\d|\d\s?\$|\bUSD\b)/;
/** Text right before a sum that means it is not the product price (savings, free delivery from …). */
const NOT_A_PRICE = /(эконом\S*|выгод\S*|скидк\S*|save|saving|tejang\S*|bepul|бесплатн\S*|free\s+\S+|from|от|dan)\W{0,3}$/i;
const OUT_OF_STOCK = /(нет в наличии|закончил|out of stock|sold out|notify me|сообщить о|mavjud emas|sotuvda yo['ʻ’]?q|tugagan)/i;
const BESTSELLER = /(бестселлер|best[\s-]?seller|хит продаж|eng ko['ʻ’]?p sotilgan)/i;
/** «#3 Best Seller», «№3 в бестселлерах», «Best Seller #3» on the page. */
const RANK_HTML = [/(?:#|№)\s*(\d{1,5})(?!\d)\s*(?:в\s+|in\s+)?(?:best[\s-]?seller|бестселлер|хит)/i, /(?:best[\s-]?seller|бестселлер)\D{0,20}?(?:#|№)\s*(\d{1,5})(?!\d)/i];
/** In a hand table: «#3», «№ 3», «место 3», «rank 3». */
const RANK_TABLE = /(?:(?:#|№)\s*|(?:место|rank|top|топ)\s*)(\d{1,5})(?!\d)/i;
const rankOf = (text: string, res: RegExp[]) => {
  for (const r of res) {
    const m = r.exec(text);
    if (m && Number(m[1]) >= 1) return Number(m[1]);
  }
  return null;
};
const WEIGHT = /(\d+(?:[.,]\d+)?)\s*(kg|кг|lbs?|фунт)(?![a-zа-я])/i;
/** An element whose sum is the old (crossed-out) price. */
const STRUCK_TAG = /^(del|s|strike)$/i;
const STRUCK_CLASS = /class\s*=\s*["'][^"']*(?:old|strike|original|was-price|regular|list-price|crossed)[^"']*["']/i;

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCharCode(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/**
 * The visible text of a piece of the page, and for every character whether it sits inside a crossed-out element
 * (<del>, <s>, or a class like "price-old"). Scripts and styles are dropped.
 */
function visible(html: string): { text: string; struck: boolean[] } {
  const src = html.replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  let text = '';
  const struck: boolean[] = [];
  const stack: { name: string; depth: number }[] = [];
  const push = (s: string) => {
    const t = decode(s);
    text += t;
    for (let i = 0; i < t.length; i++) struck.push(stack.length > 0);
  };
  const re = /<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    push(src.slice(last, m.index));
    last = re.lastIndex;
    const tag = m[0];
    const name = m[1].toLowerCase();
    const top = stack[stack.length - 1];
    if (tag[1] === '/') {
      if (top && top.name === name && --top.depth === 0) stack.pop();
    } else if (!tag.endsWith('/>')) {
      if (top && top.name === name) top.depth++;
      else if (STRUCK_TAG.test(name) || STRUCK_CLASS.test(tag)) stack.push({ name, depth: 1 });
    }
    push(' ');
  }
  push(src.slice(last));
  return { text, struck };
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const digits = (s: string) => Number(s.replace(/\D/g, ''));

interface Sum {
  value: number;
  at: number;
  struck: boolean;
}

/** All sums in a piece of the page, in order of appearance. */
function sumsIn(text: string, struck: boolean[]): Sum[] {
  const out: Sum[] = [];
  for (const re of [PRICE_AFTER, PRICE_BEFORE]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const value = digits(m[1]);
      if (value < 1000 || value > 1_000_000_000) continue; // a sum price is thousands; 0 / years / counters are not
      if (NOT_A_PRICE.test(squash(text.slice(Math.max(0, m.index - 40), m.index)))) continue;
      const numAt = m.index + m[0].indexOf(m[1]);
      if (!out.some((o) => Math.abs(o.at - numAt) < 3)) out.push({ value, at: numAt, struck: !!struck[numAt] });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function weightOf(text: string): number | null {
  const w = WEIGHT.exec(text);
  if (!w) return null;
  const n = Number(w[1].replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 50) return null;
  return Math.round((/lb|фунт/i.test(w[2]) ? n * 0.45359237 : n) * 1000) / 1000;
}

/** The product name: the longest link text or title="" of this product's links. */
function titleOf(part: string, id: string): string | null {
  let best = '';
  const re = new RegExp(String.raw`<a\b([^>]*\/pr\/(?:[^"'/?#]+\/)?` + id + String.raw`(?!\d)[^>]*)>([\s\S]*?)<\/a\s*>`, 'gi');
  for (let m = re.exec(part); m; m = re.exec(part)) {
    const attr = squash(decode(/title\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1] ?? ''));
    const inner = squash(visible(m[2]).text);
    for (const t of [attr, inner]) if (t.length > best.length && !new RegExp(NUM + String.raw`\s*` + CUR, 'i').test(t)) best = t;
  }
  return best ? best.slice(0, 300) : null;
}

/** The saved wishlist page: one product = from its first link to the next product's first link. */
function parseHtml(html: string): WishlistParse {
  const firsts: { id: string; at: number }[] = [];
  PRODUCT_HREF.lastIndex = 0;
  for (let m = PRODUCT_HREF.exec(html); m; m = PRODUCT_HREF.exec(html)) {
    if (!firsts.some((f) => f.id === m![2])) firsts.push({ id: m[2], at: m.index });
  }
  const items: WishlistItem[] = [];
  const problems: string[] = [];
  firsts.forEach((f, i) => {
    // never a neighbour's price: the piece ends where the next product begins
    const part = html.slice(f.at, i + 1 < firsts.length ? firsts[i + 1].at : Math.min(html.length, f.at + 8000));
    const { text, struck } = visible(part);
    const title = titleOf(part, f.id);
    const sums = sumsIn(text, struck);
    const current = sums.find((s) => !s.struck);
    if (!current) {
      problems.push(`${title ?? 'Товар'} (iHerb ${f.id}): цена в сумах не найдена`);
      return;
    }
    const old = sums.find((s) => s.struck && s.value > current.value);
    const plain = squash(text);
    items.push({
      iherb_product_id: f.id,
      title,
      price_uzs: current.value,
      list_price_uzs: old?.value ?? null,
      in_stock: !OUT_OF_STOCK.test(plain),
      bestseller: BESTSELLER.test(plain) || rankOf(plain, RANK_HTML) != null,
      bestseller_rank: rankOf(plain, RANK_HTML),
      weight_kg: weightOf(plain),
    });
  });
  return { format: 'html', items, problems, wrong_currency: false };
}

/**
 * A table typed or pasted by hand (from Excel, Google Sheets, a note): one product per line —
 * an iHerb link or number, then the price in sum; «нет» (or 0) in another column means «нет в наличии».
 */
function parseTable(input: string): WishlistParse {
  const items: WishlistItem[] = [];
  const problems: string[] = [];
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(ссылка|link|номер|товар|iherb\s*(id|№|номер))/i.test(line)) continue;
    let id: string | undefined;
    let rest = line;
    const link = PRODUCT_LINK_IN_TEXT.exec(line);
    if (link) {
      id = link[1];
      rest = line.replace(link[0], '\t');
    } else {
      const num = /^#?(\d{2,10})(?=[\s;,|]|$)/.exec(line);
      if (num) {
        id = num[1];
        rest = '\t' + line.slice(num[0].length);
      }
    }
    if (!id) {
      problems.push(`«${line.slice(0, 80)}»: нет ссылки или номера товара iHerb`);
      continue;
    }
    // «#3» / «место 3» is the best-seller place, not a price: taken out before the price is looked for
    const rank = rankOf(rest, [RANK_TABLE]);
    if (rank != null) rest = rest.replace(RANK_TABLE, ' ');
    // the first sum after the number is the price; whatever is left («нет», «бестселлер», «0.2 kg») are notes
    const pm = new RegExp(NUM + String.raw`\s*(?:` + CUR + ')?', 'i').exec(rest);
    const price = pm ? digits(pm[1]) : 0;
    if (!pm || price < 1000 || price > 1_000_000_000) {
      problems.push(`iHerb ${id}: нет цены в сумах`);
      continue;
    }
    const other = squash(rest.replace(pm[0], ' ').replace(/[\t;|]/g, ' '));
    items.push({
      iherb_product_id: id,
      title: null,
      price_uzs: price,
      list_price_uzs: null,
      in_stock: !(/(^|\s)(нет|no|yo['ʻ’]?q|0)(\s|$)/i.test(other) || OUT_OF_STOCK.test(other)),
      bestseller: BESTSELLER.test(other) || rank != null,
      bestseller_rank: rank,
      weight_kg: weightOf(other),
    });
  }
  return { format: 'table', items, problems, wrong_currency: false };
}

/** Reads the wishlist the owner gave: the saved page (HTML) or a table. Duplicates keep the first one. */
export function parseWishlist(input: string): WishlistParse {
  const isHtml = /<(html|body|div|a|li|span)\b/i.test(input) && /\/pr\//i.test(input);
  const res = isHtml ? parseHtml(input) : parseTable(input);
  const seen = new Set<string>();
  res.items = res.items.filter((i) => {
    if (seen.has(i.iherb_product_id)) {
      res.problems.push(`iHerb ${i.iherb_product_id}: встречается несколько раз — взята первая строка`);
      return false;
    }
    seen.add(i.iherb_product_id);
    return true;
  });
  if (res.items.length > WISHLIST_MAX_ITEMS) {
    res.problems.push(`Больше ${WISHLIST_MAX_ITEMS} товаров — взяты первые ${WISHLIST_MAX_ITEMS}`);
    res.items = res.items.slice(0, WISHLIST_MAX_ITEMS);
  }
  // prices in dollars and none in sum: the owner switches the currency on iHerb (we do not convert)
  if (!res.items.length && DOLLARS.test(isHtml ? visible(input).text : input)) res.wrong_currency = true;
  return res;
}
