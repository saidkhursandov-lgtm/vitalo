import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, ErrorBox, Loading, PageHead, Pagination } from '../components/ui';
import { api, qs } from '../lib/api';
import { useSession } from '../lib/auth';
import { money, PRODUCT_STATUS } from '../lib/format';
import { SupplierTabs } from '../components/SupplierTabs';

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
}

export function Products() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const status = params.get('status') ?? '';
  const page = Number(params.get('page')) || 1;
  const yandex = can('yandex.price.view');
  const syncOnly = params.get('yandex_sync') === '1';
  const supplier = params.get('supplier') ?? '';
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ['products', params.toString()],
    queryFn: () =>
      api<{ items: ProductRow[]; total: number; total_pages: number }>(
        `/staff/products${qs({ q: params.get('q'), status, page, yandex_sync_needed: syncOnly ? 'true' : undefined, supplier_id: supplier || undefined })}`,
      ),
  });
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
      </form>
      <ErrorBox error={synced.error} />
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <section className="card flush">
          <table className="table table-hover">
            <thead>
              <tr>
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
                  <td className="thumb-cell">{p.image_url ? <img src={p.image_url} alt="" className="thumb" /> : <div className="thumb" />}</td>
                  <td>
                    <Link to={`/products/${p.id}`} className="strong">
                      {p.name_ru}
                    </Link>
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
                  <td className={`num ${p.available_qty <= p.min_stock ? 'text-warn' : ''}`}>
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
