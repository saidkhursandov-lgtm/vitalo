import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, ErrorBox, Loading, PageHead, Pagination } from '../components/ui';
import { api, qs } from '../lib/api';
import { useSession } from '../lib/auth';
import { money, PRODUCT_STATUS } from '../lib/format';
import { SupplierTabs } from '../components/SupplierTabs';
import { useShowTest } from '../components/TestFlag';

interface ProductRow {
  id: string;
  sku: string;
  name_ru: string;
  brand: string;
  price_uzs: number;
  status: string;
  min_stock: number;
  image_url: string | null;
  actual_qty: number;
  available_qty: number;
  /** absent for roles without yandex.price.view (warehouse) */
  yandex_price_uzs?: number | null;
  yandex_price_sync_needed?: boolean;
  /** D-61: «Где берём» and the «под заказ» one */
  suppliers: { id: string; name: string }[];
  on_zero_supplier: { id: string; name: string } | null;
  is_test?: boolean;
}

/** Аудит 2.5: «problems» of the cards, each a filter with its counter. */
const PROBLEMS = [
  ['no_photo', 'Без фото'],
  ['no_ikpu', 'Без ИКПУ'],
  ['no_uz', 'Без текста UZ'],
  ['yandex_mismatch', 'Цена Яндекса не совпадает'],
] as const;
type Problem = (typeof PROBLEMS)[number][0];
const SORTS: [string, string][] = [
  ['', 'Сначала активные'],
  ['name', 'По названию'],
  ['price_asc', 'Цена: дешевле'],
  ['price_desc', 'Цена: дороже'],
  ['stock_asc', 'Остаток: меньше'],
  ['stock_desc', 'Остаток: больше'],
];
type BulkStatus = 'active' | 'hidden' | 'archived';
const BULK_TEXT: Record<BulkStatus, string> = { hidden: 'Скрыть', active: 'Показать', archived: 'В архив' };

export function Products() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const status = params.get('status') ?? '';
  const page = Number(params.get('page')) || 1;
  const yandex = can('yandex.price.view');
  const syncOnly = params.get('yandex_sync') === '1';
  const supplier = params.get('supplier') ?? '';
  const sort = params.get('sort') ?? '';
  const problem = params.get('problem') ?? '';
  const client = useQueryClient();
  const editable = can('products.edit');
  const [picked, setPicked] = useState<string[]>([]);
  const { hideTest, toggle: testToggle } = useShowTest();
  const q = useQuery({
    queryKey: ['products', params.toString()],
    queryFn: () =>
      api<{ items: ProductRow[]; total: number; total_pages: number; problems?: Record<Problem, number> }>(
        `/staff/products${qs({ q: params.get('q'), status, page, yandex_sync_needed: syncOnly ? 'true' : undefined, supplier_id: supplier || undefined, hide_test: hideTest, sort: sort || undefined, problem: problem || undefined })}`,
      ),
  });
  // аудит 2.5 (D-64): «Скрыть / Показать / В архив» for the ticked products, after a confirmation
  const bulk = useMutation({
    mutationFn: (to: BulkStatus) => api<{ changed: number; unchanged: number }>('/staff/products/bulk-status', { method: 'POST', body: { ids: picked, status: to } }),
    onSuccess: () => {
      setPicked([]);
      void client.invalidateQueries({ queryKey: ['products'] });
    },
  });
  const askBulk = (to: BulkStatus) => {
    const rows = (q.data?.items ?? []).filter((p) => picked.includes(p.id));
    const withStock = rows.filter((p) => p.actual_qty > 0);
    const units = withStock.reduce((s, p) => s + p.actual_qty, 0);
    const value = withStock.reduce((s, p) => s + p.actual_qty * p.price_uzs, 0);
    const warning =
      to === 'archived' && withStock.length
        ? `\n\nВнимание: у ${withStock.length} из них есть остаток на складе — ${units} шт. на ${money(value)} по цене продажи. В архиве их не будет видно в магазине.`
        : '';
    if (window.confirm(`${BULK_TEXT[to]}: ${picked.length} товар(ов)?${warning}`)) bulk.mutate(to);
  };
  const pageIds = (q.data?.items ?? []).map((p) => p.id);
  const allPicked = pageIds.length > 0 && pageIds.every((id) => picked.includes(id));
  const pick = (id: string, on: boolean) => setPicked((x) => (on ? [...x, id] : x.filter((y) => y !== id)));
  const synced = useMutation({
    mutationFn: (id: string) => api(`/staff/products/${id}/yandex-price-synced`, { method: 'POST' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['products'] }),
  });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.delete('page');
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPicked([]);
  };

  return (
    <>
      <PageHead title="Товары">
        {can('products.edit') && (
          <Link to="/products/new" className="btn">
            + Новый товар
          </Link>
        )}
      </PageHead>
      <SupplierTabs value={supplier} onChange={(v) => set('supplier', v)} />
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          set('q', text);
        }}
      >
        <input placeholder="SKU, название или бренд — Enter" value={text} onChange={(e) => setText(e.target.value)} />
        <select value={status} onChange={(e) => set('status', e.target.value)} aria-label="Статус">
          <option value="">Все статусы</option>
          {Object.entries(PRODUCT_STATUS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {yandex && (
          <label className="check">
            <input type="checkbox" checked={syncOnly} onChange={(e) => set('yandex_sync', e.target.checked ? '1' : '')} />
            Цена Яндекса требует синхронизации
          </label>
        )}
        <select value={sort} onChange={(e) => set('sort', e.target.value)} aria-label="Порядок">
          {SORTS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {testToggle}
      </form>
      {q.data?.problems && (
        <div className="chips" role="group" aria-label="Проблемы карточек">
          {PROBLEMS.filter(([k]) => k !== 'yandex_mismatch' || yandex).map(([k, label]) => (
            <button key={k} type="button" className={`chip ${problem === k ? 'is-on' : ''}`} aria-pressed={problem === k} onClick={() => set('problem', problem === k ? '' : k)}>
              {label} <span className="chip-count">{q.data.problems![k]}</span>
            </button>
          ))}
        </div>
      )}
      {editable && picked.length > 0 && (
        <div className="bulk-bar">
          <span>
            Выбрано: <strong>{picked.length}</strong>
          </span>
          {(['hidden', 'active', 'archived'] as BulkStatus[]).map((to) => (
            <button key={to} type="button" className="btn btn-sm btn-ghost" disabled={bulk.isPending} onClick={() => askBulk(to)}>
              {BULK_TEXT[to]}
            </button>
          ))}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicked([])}>
            Снять выбор
          </button>
        </div>
      )}
      <ErrorBox error={synced.error ?? bulk.error} />
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <section className="card flush">
          <table className="table table-hover">
            <thead>
              <tr>
                {editable && (
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Выбрать все на странице"
                      checked={allPicked}
                      onChange={(e) => setPicked(e.target.checked ? [...new Set([...picked, ...pageIds])] : picked.filter((id) => !pageIds.includes(id)))}
                    />
                  </th>
                )}
                <th />
                <th>Товар</th>
                <th>Бренд</th>
                <th>Где берём</th>
                <th className="num">Цена</th>
                {yandex && <th className="num">Яндекс</th>}
                <th className="num">Доступно / всего</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((p) => (
                <tr key={p.id}>
                  {editable && (
                    <td>
                      <input type="checkbox" aria-label={`Выбрать: ${p.name_ru}`} checked={picked.includes(p.id)} onChange={(e) => pick(p.id, e.target.checked)} />
                    </td>
                  )}
                  <td className="thumb-cell">{p.image_url ? <img src={p.image_url} alt="" className="thumb" /> : <div className="thumb" />}</td>
                  <td>
                    <Link to={`/products/${p.id}`} className="strong">
                      {p.name_ru}
                    </Link>
                    {p.is_test && (
                      <>
                        {' '}
                        <Badge tone="warn">Тест</Badge>
                      </>
                    )}
                    <div className="muted small">{p.sku}</div>
                  </td>
                  <td>{p.brand}</td>
                  <td className="small">
                    {p.suppliers.length ? p.suppliers.map((s) => s.name).join(', ') : <span className="muted">—</span>}
                    {p.on_zero_supplier && <div className="muted">ноль → под заказ: {p.on_zero_supplier.name}</div>}
                  </td>
                  <td className="num">{money(p.price_uzs)}</td>
                  {yandex && (
                    <td className="num">
                      {p.yandex_price_uzs != null ? money(p.yandex_price_uzs) : <span className="muted">—</span>}
                      {p.yandex_price_uzs != null && p.yandex_price_uzs !== p.price_uzs && (
                        <div>
                          <Badge tone="bad">не совпадает с ценой магазина</Badge>
                        </div>
                      )}
                      {p.yandex_price_sync_needed && (
                        <div>
                          <Badge tone="warn">Цена Яндекса требует синхронизации</Badge>
                          {can('yandex.price.sync') && (
                            <button type="button" className="btn btn-sm btn-ghost" disabled={synced.isPending} onClick={() => synced.mutate(p.id)}>
                              Отметить синхронизированной
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  )}
                  <td className={`num ${p.min_stock > 0 && p.available_qty <= p.min_stock ? 'text-warn' : ''}`}>
                    {p.available_qty} / {p.actual_qty}
                  </td>
                  <td>
                    <Badge tone={p.status === 'active' ? 'ok' : p.status === 'archived' ? 'bad' : 'neutral'}>{PRODUCT_STATUS[p.status]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-foot">
            <span className="muted">Всего: {q.data.total}</span>
            <Pagination page={page} totalPages={q.data.total_pages} onPage={(p) => set('page', String(p))} />
          </div>
        </section>
      )}
    </>
  );
}
