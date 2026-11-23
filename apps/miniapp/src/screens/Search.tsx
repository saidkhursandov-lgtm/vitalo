import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CloseIcon, SearchIcon } from '../components/Icons';
import { EmptyState, ErrorState, Loading, ProductGrid, ProductStrip } from '../components/ui';
import { CategoryLink } from '../components/CatalogLayers';
import { useI18n } from '../lib/i18n';
import { useCategories, useHomeStrips, useSearch } from '../lib/queries';

const RECENT_KEY = 'vitalo.search.recent';
const RECENT_MAX = 6;

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function writeRecent(list: string[]) {
  try {
    if (list.length) localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    else localStorage.removeItem(RECENT_KEY);
  } catch {
    /* private mode: recent searches are only a convenience */
  }
}

/**
 * Search with typo tolerance and transliteration (done by the API). The query is kept in the URL.
 * 23.11.2026: the field is the same size as on the home screen, and before typing the screen is not empty —
 * recent searches, popular queries, needs and «Популярное», so the customer always has something to tap.
 */
export function Search() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const [q, setQ] = useState(text);
  const [recent, setRecent] = useState(readRecent);

  useEffect(() => {
    const id = setTimeout(() => {
      setQ(text.trim());
      setParams(text.trim() ? { q: text.trim() } : {}, { replace: true });
    }, 300);
    return () => clearTimeout(id);
  }, [text, setParams]);

  const results = useSearch(q);
  const items = results.data?.pages.flatMap((p) => p.items) ?? [];
  const suggestions = [t('search.suggest1'), t('search.suggest2')];

  // a query that found something is remembered (on Enter or when the field loses focus)
  const remember = () => {
    const v = q.trim();
    if (v.length < 2 || items.length === 0) return;
    const next = [v, ...recent.filter((x) => x.toLowerCase() !== v.toLowerCase())].slice(0, RECENT_MAX);
    setRecent(next);
    writeRecent(next);
  };
  const clearRecent = () => {
    setRecent([]);
    writeRecent([]);
  };

  return (
    <div className="page search-page">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          remember();
          (document.activeElement as HTMLElement | null)?.blur();
        }}
      >
        <label className="search-box">
          <SearchIcon width={22} height={22} />
          <input
            autoFocus
            type="search"
            enterKeyHint="search"
            aria-label={t('search.title')}
            placeholder={t('search.placeholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={remember}
          />
          {text && (
            <button type="button" className="search-clear" aria-label={t('search.clear')} onClick={() => setText('')}>
              <CloseIcon width={18} height={18} />
            </button>
          )}
        </label>
      </form>

      {q.length < 2 ? (
        <SearchStart recent={recent} onPick={setText} onClear={clearRecent} />
      ) : results.isPending ? (
        <Loading variant="grid" />
      ) : results.isError ? (
        <ErrorState error={results.error} onRetry={() => void results.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={t('search.emptyTitle')}
          text={t('search.emptyHint')}
          action={
            <div className="chips wrap center">
              {suggestions.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => setText(s)}>
                  {s}
                </button>
              ))}
              <Link to="/catalog" className="chip">
                {t('common.toCatalog')}
              </Link>
            </div>
          }
        />
      ) : (
        <>
          <p className="hint small">{t('catalog.found', { n: results.data.pages[0].total })}</p>
          <ProductGrid products={items} />
          {results.hasNextPage && (
            <button className="btn btn-secondary btn-block" onClick={() => void results.fetchNextPage()}>
              {t('common.showMore')}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** What the search screen shows before the customer types: recent and popular queries, needs, «Популярное». */
function SearchStart({ recent, onPick, onClear }: { recent: string[]; onPick: (q: string) => void; onClear: () => void }) {
  const { t } = useI18n();
  const categories = useCategories();
  const strips = useHomeStrips();
  const popular = t('search.popularQueries')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div className="search-start">
      {recent.length > 0 && (
        <section className="search-block">
          <div className="section-head">
            <h2>{t('search.recent')}</h2>
            <button type="button" className="link" onClick={onClear}>
              {t('search.clearRecent')}
            </button>
          </div>
          <div className="chips wrap">
            {recent.map((s) => (
              <button key={s} type="button" className="chip" onClick={() => onPick(s)}>
                {s}
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="search-block">
        <div className="section-head">
          <h2>{t('search.popularTitle')}</h2>
        </div>
        <div className="chips wrap">
          {popular.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => onPick(s)}>
              <SearchIcon width={14} height={14} aria-hidden /> {s}
            </button>
          ))}
        </div>
      </section>
      {categories.data && categories.data.need.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>{t('home.byNeed')}</h2>
          </div>
          <div className="need-list scroll-x">
            {categories.data.need.map((c) => (
              <CategoryLink key={c.id} c={c} className="need-card" />
            ))}
          </div>
        </section>
      )}
      <ProductStrip
        title={t('home.popular')}
        products={strips.data?.popular ?? []}
        more={<Link to="/catalog/products?sort=popular" className="link">{t('home.all')}</Link>}
      />
    </div>
  );
}
