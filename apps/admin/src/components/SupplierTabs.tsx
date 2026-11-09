import { useDictionary, type DictionaryValue } from './DictionarySelect';

/** D-61: what a supplier is. ozon — bought for the stock; local — a Tashkent supplier; foreign — from abroad («из США»). */
export type SupplierKind = 'ozon' | 'local' | 'foreign';
export interface Supplier extends DictionaryValue {
  code: string | null;
  kind: SupplierKind;
  from_ru: string | null;
  from_uz: string | null;
  days_min: number | null;
  days_max: number | null;
  guarantee_days: number | null;
  sort: number;
  /** products bought from it (`products` is the number of purchases) */
  product_count: number;
}
export const SUPPLIER_KIND_LABELS: Record<SupplierKind, string> = {
  ozon: 'Ozon — на склад',
  local: 'Местный',
  foreign: 'Из-за рубежа',
};
/** The «под заказ» terms when the supplier's own are empty (same as the API). */
export const SUPPLIER_DEFAULT_TERMS: Record<'local' | 'foreign', { days_min: number; days_max: number; guarantee_days: number }> = {
  local: { days_min: 1, days_max: 2, guarantee_days: 7 },
  foreign: { days_min: 7, days_max: 14, guarantee_days: 21 },
};
/** «7–14 дней, гарантия 21» of a local or foreign supplier; null for Ozon. */
export function supplierTerms(s: Pick<Supplier, 'kind' | 'days_min' | 'days_max' | 'guarantee_days'>): string | null {
  if (s.kind === 'ozon') return null;
  const d = SUPPLIER_DEFAULT_TERMS[s.kind];
  const min = s.days_min ?? d.days_min;
  const max = s.days_max ?? d.days_max;
  return `${min === max ? min : `${min}–${max}`} дн., гарантия ${s.guarantee_days ?? d.guarantee_days} дн.`;
}

export const useSuppliers = () => {
  const q = useDictionary('suppliers');
  return { ...q, data: q.data as Supplier[] | undefined };
};

/**
 * D-61: «Все · Ozon · iHerb · Glorious … · Без поставщика» — the supplier tabs of «Товары» and «Бренды».
 * value: '' (all), a supplier id or 'none'.
 */
export function SupplierTabs({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const q = useSuppliers();
  const active = (q.data ?? []).filter((s) => s.status === 'active' || s.id === value);
  if (!active.length) return null;
  const tabs = [{ id: '', label: 'Все' }, ...active.map((s) => ({ id: s.id, label: s.name_ru })), { id: 'none', label: 'Без поставщика' }];
  return (
    <div className="segmented supplier-tabs" role="tablist" aria-label="Поставщик">
      {tabs.map((t) => (
        <button key={t.id || 'all'} type="button" role="tab" aria-selected={value === t.id} className={value === t.id ? 'is-on' : ''} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
