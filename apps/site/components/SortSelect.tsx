'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { Lang } from '@/lib/types';

const SORTS = ['popular', 'price_asc', 'price_desc', 'new'] as const;

export function SortSelect({ lang, value }: { lang: Lang; value: string }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  return (
    <select
      className="select"
      aria-label={t(lang, 'catalog.sort')}
      value={value}
      onChange={(e) => {
        const u = new URLSearchParams(params.toString());
        u.delete('page');
        if (e.target.value === 'popular') u.delete('sort');
        else u.set('sort', e.target.value);
        const s = u.toString();
        router.push(s ? `${path}?${s}` : path);
      }}
    >
      {SORTS.map((s) => (
        <option key={s} value={s}>
          {t(lang, `sort.${s}`)}
        </option>
      ))}
    </select>
  );
}

/** Phone: the filter panel opens with a button; on a wide screen it always stands on the left. */
export function FilterToggle({ lang, count, children }: { lang: Lang; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`filters-wrap${open ? ' is-open' : ''}`}>
      <button type="button" className="btn btn-secondary btn-block filters-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <SlidersHorizontal size={18} strokeWidth={1.8} /> {t(lang, 'catalog.filters')}
        {count ? <span className="badge-count">{count}</span> : null}
      </button>
      {children}
    </div>
  );
}
