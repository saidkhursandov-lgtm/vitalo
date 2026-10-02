import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SearchIcon } from '../components/Icons';
import { Empty, ErrorState, Loading, ProductGrid } from '../components/ui';
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

  return (
    <div className="page">
      <label className="search-box">
        <SearchIcon width={20} height={20} />
        <input autoFocus type="search" enterKeyHint="search" placeholder={t('search.placeholder')} value={text} onChange={(e) => setText(e.target.value)} />
      </label>

      {q.length < 2 ? (
        <Empty>{t('search.hint')}</Empty>
      ) : results.isPending ? (
        <Loading />
      ) : results.isError ? (
        <ErrorState error={results.error} onRetry={() => void results.refetch()} />
      ) : items.length === 0 ? (
        <Empty>{t('catalog.empty')}</Empty>
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
