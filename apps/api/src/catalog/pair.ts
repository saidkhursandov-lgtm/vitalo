/**
 * Release 4.1 «Идеальная пара»: the second jar shown in the product card. Picked from the approved synergy rules
 * (D3 → K2, магний → B6, коллаген → C): a product in stock with the missing substance. No database here.
 */

export interface PairRule {
  a: string;
  b: string;
  text_ru: string;
  text_uz: string;
}

export interface PairProduct {
  id: string;
  /** adult | child | any */
  audience: string | null;
  /** substance ids with their parents (a form counts as its substance) */
  substances: Set<string>;
  /** the label substances with their parents: «Витамин C» in the label beats a multivitamin that also has C */
  label: Set<string>;
  popularity: number;
  price: number;
}

export interface PairPick {
  product_id: string;
  rule: PairRule | null;
}

const childOnly = (p: Pick<PairProduct, 'audience'>) => p.audience === 'child';

/** A child product pairs only with a child one; an adult or universal product never with a child one. */
export function audienceFits(main: Pick<PairProduct, 'audience'>, other: Pick<PairProduct, 'audience'>): boolean {
  return childOnly(main) === childOnly(other);
}

/**
 * The best pair for a product, or null. A rule counts when the product has one of its substances and not the other
 * (D3 + K2 in one jar needs no pair). The pair has the missing substance in its label (a main one: not a pinch of
 * biotin in a protein shake) and not the substance the product already gives (коллаген + гиалурон is not a pair of
 * коллаген + C). Among those in stock: the best seller, then the cheaper one.
 */
export function pickPair(main: PairProduct, candidates: PairProduct[], rules: PairRule[]): PairPick | null {
  let best: { p: PairProduct; rule: PairRule } | null = null;
  for (const rule of rules) {
    const need = main.substances.has(rule.a) && !main.substances.has(rule.b) ? rule.b : main.substances.has(rule.b) && !main.substances.has(rule.a) ? rule.a : null;
    if (!need) continue;
    const have = need === rule.a ? rule.b : rule.a;
    // the rule is about a main substance of the product too: a pinch of D3 in a protein shake asks for no magnesium
    if (!main.label.has(have)) continue;
    for (const c of candidates) {
      if (c.id === main.id || !c.label.has(need) || c.substances.has(have) || !audienceFits(main, c)) continue;
      if (!best || c.popularity > best.p.popularity || (c.popularity === best.p.popularity && c.price < best.p.price)) best = { p: c, rule };
    }
  }
  return best && { product_id: best.p.id, rule: best.rule };
}

/** The rule that joins two products (for a pair chosen by hand), or null. */
export function ruleBetween(a: Pick<PairProduct, 'substances'>, b: Pick<PairProduct, 'substances'>, rules: PairRule[]): PairRule | null {
  return rules.find((r) => (a.substances.has(r.a) && b.substances.has(r.b)) || (a.substances.has(r.b) && b.substances.has(r.a))) ?? null;
}
