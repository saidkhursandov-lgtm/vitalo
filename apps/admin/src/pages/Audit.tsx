import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ErrorBox, Loading, PageHead, Pagination } from '../components/ui';
import { api, qs } from '../lib/api';
import { AUDIT_ACTION, dateTime, ROLE } from '../lib/format';

interface AuditRow {
  id: string;
  created_at: string;
  staff: { id: string; name: string; role: string } | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

const AREAS = [
  ['', 'Все действия'],
  ['order.', 'Заказы'],
  ['product.', 'Товары'],
  ['inventory.', 'Склад'],
  ['customer.', 'Клиенты'],
  ['settings.', 'Реквизиты'],
  ['tariff.', 'Тарифы'],
  ['staff.', 'Сотрудники'],
] as const;

const LINK: Record<string, string> = { order: '/orders/', product: '/products/', user: '/customers/' };

/** Who / what / when / before / after (Master TZ §23). */
export function Audit() {
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<string | null>(null);
  const page = Number(params.get('page')) || 1;
  const filters = { action: params.get('action'), entity_id: params.get('entity_id'), date_from: params.get('date_from'), date_to: params.get('date_to') };
  const q = useQuery({
    queryKey: ['audit', params.toString()],
    queryFn: () => api<{ items: AuditRow[]; total: number; total_pages: number }>(`/staff/audit${qs({ ...filters, page })}`),
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
      <PageHead title="Журнал аудита" />
      <div className="filters">
        <select value={filters.action ?? ''} onChange={(e) => set('action', e.target.value)} aria-label="Раздел">
          {AREAS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input type="date" value={filters.date_from ?? ''} onChange={(e) => set('date_from', e.target.value)} aria-label="С даты" />
        <input type="date" value={filters.date_to ?? ''} onChange={(e) => set('date_to', e.target.value)} aria-label="По дату" />
        {filters.entity_id && (
          <button className="btn btn-sm btn-ghost" onClick={() => set('entity_id', '')}>
            Только объект {filters.entity_id.slice(0, 8)}… ✕
          </button>
        )}
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : (
        <section className="card flush">
          <table className="table table-hover">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Кто</th>
                <th>Что сделано</th>
                <th>Объект</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((r) => (
                <Fragment key={r.id}>
                  <tr>
                    <td>{dateTime(r.created_at)}</td>
                    <td>
                      {r.staff?.name ?? 'система'}
                      {r.staff && <div className="muted small">{ROLE[r.staff.role]}</div>}
                    </td>
                    <td>{AUDIT_ACTION[r.action] ?? r.action}</td>
                    <td>
                      {r.entity_id && LINK[r.entity_type] ? <Link to={`${LINK[r.entity_type]}${r.entity_id}`}>{r.entity_type}</Link> : r.entity_type}
                      {r.entity_id && (
                        <button className="btn btn-sm btn-ghost" title="Все записи по этому объекту" onClick={() => set('entity_id', r.entity_id!)}>
                          ⌕
                        </button>
                      )}
                    </td>
                    <td>
                      <button className="btn btn-sm btn-ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>
                        {open === r.id ? 'Скрыть' : 'До / после'}
                      </button>
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr className="details-row">
                      <td colSpan={5}>
                        <Diff before={r.before} after={r.after} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          <div className="table-foot">
            <span className="muted">Записей: {q.data.total}</span>
            <Pagination page={page} totalPages={q.data.total_pages} onPage={(p) => set('page', String(p))} />
          </div>
        </section>
      )}
    </>
  );
}

const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Field-by-field before/after; changed values are highlighted. */
export function Diff({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((k) => !['created_at', 'updated_at'].includes(k));
  if (!keys.length) return <span className="muted">Нет данных</span>;
  return (
    <table className="table diff">
      <thead>
        <tr>
          <th>Поле</th>
          <th>До</th>
          <th>После</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => {
          const b = show(before?.[k]);
          const a = show(after?.[k]);
          return (
            <tr key={k} className={b !== a ? 'changed' : ''}>
              <td>{k}</td>
              <td>{b}</td>
              <td>{a}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
