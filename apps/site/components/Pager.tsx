import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/** Page numbers 1 … 4 5 6 … 12; every page has its own address. */
export function Pager({ page, totalPages, href }: { page: number; totalPages: number; href: (n: number) => string }) {
  if (totalPages <= 1) return null;
  const nums = [...new Set([1, totalPages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= totalPages))].sort((a, b) => a - b);
  return (
    <nav className="pager" aria-label="pages">
      {page > 1 ? (
        <Link href={href(page - 1)} rel="prev" aria-label="prev">
          <ChevronLeft size={18} />
        </Link>
      ) : null}
      {nums.map((n, i) => (
        <span key={n} style={{ display: 'contents' }}>
          {i > 0 && n - nums[i - 1] > 1 ? <span className="gap">…</span> : null}
          {n === page ? (
            <span className="is-on" aria-current="page">
              {n}
            </span>
          ) : (
            <Link href={href(n)}>{n}</Link>
          )}
        </span>
      ))}
      {page < totalPages ? (
        <Link href={href(page + 1)} rel="next" aria-label="next">
          <ChevronRight size={18} />
        </Link>
      ) : null}
    </nav>
  );
}
