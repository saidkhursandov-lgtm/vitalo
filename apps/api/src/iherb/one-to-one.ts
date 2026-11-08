import { normalizeMatchForm } from './iherb-fields';

/**
 * Генплан, этап 5, ветка iherb-4-competitors (D-57, узел 4): the strict «1-в-1» match. A competitor price is compared
 * with ours only when the brand, the chemical form, the dose per capsule / tablet / serving and the pack count are the
 * same. One difference — «не тот товар», the row is kept but never goes to the charts or the market minimum.
 */

export interface MatchValues {
  brand: string | null;
  match_form: string | null;
  dose_amount: number | null;
  dose_unit: string | null;
  dose_per: string | null;
  pack_count: number | null;
}

export type MatchStatus = 'match' | 'mismatch' | 'incomplete';

export interface MatchResult {
  status: MatchStatus;
  /** Plain words for the admin panel, e.g. «доза: 25 мг / 50 мг». */
  reasons: string[];
}

export const UNIT_LABELS: Record<string, string> = { mg: 'мг', mcg: 'мкг', iu: 'МЕ', g: 'г', ml: 'мл', cfu_bn: 'млрд КОЕ' };
export const PER_LABELS: Record<string, string> = { capsule: 'капсула', tablet: 'таблетка', softgel: 'мягкая капсула', serving: 'порция', drop: 'капля' };

/** «NOW Foods» / «Now foods» → «nowfoods»; letters and digits only. */
const brandKey = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/gi, '');

/** «California Gold» and «California Gold Nutrition» are one brand; «NOW» and «Nordic» are not. */
function sameBrand(a: string, b: string): boolean {
  const x = brandKey(a);
  const y = brandKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short);
}

/** The dose in one unit for comparing: mcg and g → mg; МЕ, мл, КОЕ stay as they are. */
function doseKey(amount: number, unit: string): { value: number; unit: string } {
  if (unit === 'mcg') return { value: amount / 1000, unit: 'mg' };
  if (unit === 'g') return { value: amount * 1000, unit: 'mg' };
  return { value: amount, unit };
}

const doseText = (v: MatchValues) => `${formatAmount(v.dose_amount!)} ${UNIT_LABELS[v.dose_unit!] ?? v.dose_unit} на ${PER_LABELS[v.dose_per!] ?? v.dose_per}`;
const formatAmount = (n: number) => String(Math.round(n * 1000) / 1000).replace('.', ',');

function missing(v: MatchValues): string[] {
  const out: string[] = [];
  if (!v.brand?.trim()) out.push('бренд');
  if (!v.match_form?.trim()) out.push('химическая форма');
  if (v.dose_amount == null || !v.dose_unit || !v.dose_per) out.push('доза');
  if (v.pack_count == null) out.push('количество в банке');
  return out;
}

/** Ours vs the competitor's. */
export function matchOneToOne(ours: MatchValues, theirs: MatchValues): MatchResult {
  const a = missing(ours);
  const b = missing(theirs);
  if (a.length || b.length) {
    const reasons: string[] = [];
    if (a.length) reasons.push(`у товара VITALO не заполнено: ${a.join(', ')}`);
    if (b.length) reasons.push(`у конкурента не указано: ${b.join(', ')}`);
    return { status: 'incomplete', reasons };
  }
  const reasons: string[] = [];
  if (!sameBrand(ours.brand!, theirs.brand!)) reasons.push(`бренд: ${ours.brand} / ${theirs.brand}`);
  if (normalizeMatchForm(ours.match_form!) !== normalizeMatchForm(theirs.match_form!)) reasons.push(`форма: ${ours.match_form} / ${theirs.match_form}`);
  const x = doseKey(ours.dose_amount!, ours.dose_unit!);
  const y = doseKey(theirs.dose_amount!, theirs.dose_unit!);
  const sameDose = x.unit === y.unit && Math.abs(x.value - y.value) <= Math.max(x.value, y.value) * 0.0005;
  if (!sameDose || ours.dose_per !== theirs.dose_per) reasons.push(`доза: ${doseText(ours)} / ${doseText(theirs)}`);
  if (ours.pack_count !== theirs.pack_count) reasons.push(`в банке: ${ours.pack_count} / ${theirs.pack_count}`);
  return reasons.length ? { status: 'mismatch', reasons } : { status: 'match', reasons: [] };
}

export const PLATFORMS = ['uzum', 'yandex_market', 'pharmacy', 'social', 'other'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABELS: Record<Platform, string> = {
  uzum: 'Uzum Market',
  yandex_market: 'Яндекс Маркет',
  pharmacy: 'Аптека',
  social: 'Instagram / Telegram',
  other: 'Другое',
};
