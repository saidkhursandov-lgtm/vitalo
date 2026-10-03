import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SearchIcon } from '../components/Icons';
import { EmptyState, ErrorState, Loading, ProductGrid } from '../components/ui';
import { useI18n } from '../lib/i18n';
import { useSearch } from '../lib/queries';

/** Search with typo tolerance and transliteration (done by the API). The query is kept in the URL. */
export function Search() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const [q, setQ] = useState(text);

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

  return (
    <div className="page">
      {text && <div className="search-caption">{t('search.caption')}</div>}
      <label className="search-box search-box-lg">
        <SearchIcon width={22} height={22} />
        <input autoFocus type="search" enterKeyHint="search" placeholder={t('search.placeholder')} value={text} onChange={(e) => setText(e.target.value)} />
      </label>

      {q.length < 2 ? null : results.isPending ? (
        <Loading />
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
