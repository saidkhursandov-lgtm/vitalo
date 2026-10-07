import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead, Pagination, toInt } from '../components/ui';
import { api, qs } from '../lib/api';
import { useSession } from '../lib/auth';
import { CONDITION, dateTime, MOVEMENT } from '../lib/format';
import { CloseIcon } from '../components/Icons';
import { Receiving, Reconcile, Units } from './Receiving';

interface StockRow {
  product_id: string;
  sku: string;
  name_ru: string;
  min_stock: number;
  unit_tracking: boolean;
  actual_qty: number;
  reserved_qty: number;
  available_qty: number;
  low: boolean;
  warehouses: { warehouse: { id: string; name: string }; actual_qty: number; reserved_qty: number; available_qty: number }[];
}

type Op = 'receipt' | 'writeoff' | 'adjustment' | 'return';
const OP_TITLE: Record<Op, string> = { receipt: 'Приход', writeoff: 'Списание', adjustment: 'Корректировка (пересчёт)', return: 'Возврат на склад' };

/** «Склад» tabs; Приёмка / Единицы / Сверка (stage 2B) only with their permissions. */
const TABS = [
  ['stock', 'Остатки', null],
  ['movements', 'История движений', null],
  ['receiving', 'Приёмка', 'receiving.perform'],
  ['units', 'Единицы', 'units.view'],
  ['reconcile', 'Сверка', 'units.view'],
] as const;

export function Inventory() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter(([, , perm]) => !perm || can(perm));
  const tab = tabs.find(([t]) => t === params.get('tab'))?.[0] ?? 'stock';
  const setTab = (t: string) => setParams(t === 'stock' ? {} : { tab: t }, { replace: true });

  return (
    <>
      <PageHead title="Склад">
        <div className="segmented">
          {tabs.map(([t, label]) => (
            <button key={t} className={tab === t ? 'is-on' : ''} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
      </PageHead>
      {tab === 'stock' ? (
        <Stock editable={can('inventory.edit')} />
      ) : tab === 'movements' ? (
        <Movements />
      ) : tab === 'receiving' ? (
        <Receiving />
      ) : tab === 'units' ? (
        <Units />
      ) : (
        <Reconcile />
      )}
    </>
  );
}

function Stock({ editable }: { editable: boolean }) {
  const overrideAllowed = useSession().can('inventory.unit_override');
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const lowOnly = params.get('low_only') === 'true';
  const page = Number(params.get('page')) || 1;
  const [op, setOp] = useState<{ kind: Op; row: StockRow } | null>(null);
  const q = useQuery({
    queryKey: ['stock', params.toString()],
    queryFn: () => api<{ items: StockRow[]; total: number; total_pages: number }>(`/staff/inventory${qs({ q: params.get('q'), low_only: lowOnly, page })}`),
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
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          set('q', text);
        }}
      >
        <input placeholder="SKU, название, бренд — Enter" value={text} onChange={(e) => setText(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={lowOnly} onChange={(e) => set('low_only', e.target.checked ? 'true' : '')} />
          Только низкие остатки
        </label>
      </form>
      {!editable && <div className="alert alert-info">Только просмотр: операции со складом выполняет роль «Склад» или администратор.</div>}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <section className="card flush">
          <table className="table table-hover">
            <thead>
              <tr>
                <th>Товар</th>
                <th className="num">Всего</th>
                <th className="num">В резерве</th>
                <th className="num">Доступно</th>
                <th className="num">Минимум</th>
                <th>Операции</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((r) => (
                <tr key={r.product_id} className={r.low ? 'row-warn' : ''}>
                  <td>
                    <Link to={`/products/${r.product_id}`}>{r.name_ru}</Link>
                    <div className="muted small">
                      {r.sku} {r.unit_tracking && <Badge tone="info">по единицам</Badge>}
                    </div>
                  </td>
                  <td className="num">{r.actual_qty}</td>
                  <td className="num">{r.reserved_qty}</td>
                  <td className={`num strong ${r.available_qty <= 0 ? 'text-bad' : r.low ? 'text-warn' : ''}`}>{r.available_qty}</td>
                  <td className="num">{r.min_stock}</td>
                  <td className="ops">
                    {editable && r.unit_tracking && !overrideAllowed && <span className="muted small">Приход — через «Приёмка» </span>}
                    {editable &&
                      (!r.unit_tracking || overrideAllowed) &&
                      (Object.keys(OP_TITLE) as Op[]).map((k) => (
                        <button key={k} className="btn btn-sm btn-ghost" onClick={() => setOp({ kind: k, row: r })}>
                          {OP_TITLE[k].split(' ')[0]}
                        </button>
                      ))}
                    <Link className="btn btn-sm btn-ghost" to={`/inventory?tab=movements&product_id=${r.product_id}`}>
                      История
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-foot">
            <span className="muted">Товаров: {q.data.total}</span>
            <Pagination page={page} totalPages={q.data.total_pages} onPage={(p) => set('page', String(p))} />
          </div>
        </section>
      )}
      {op && <OperationModal kind={op.kind} row={op.row} onClose={() => setOp(null)} />}
    </>
  );
}

function OperationModal({ kind, row, onClose }: { kind: Op; row: StockRow; onClose: () => void }) {
  const client = useQueryClient();
  const { can } = useSession();
  const showCost = can('costs.view'); // purchase price: admin only
  const warehouses = useQuery({ queryKey: ['warehouses'], queryFn: () => api<{ id: string; name: string }[]>('/staff/inventory/warehouses') });
  const [f, setF] = useState({ warehouse_id: '', qty: '', actual_qty: '', reason: '', comment: '', cost_uzs: '', batch_no: '', expiry_date: '', condition: 'resellable', override_reason: '' });
  const [override, setOverride] = useState(false);
  const warehouseId = f.warehouse_id || warehouses.data?.[0]?.id || '';
  const current = row.warehouses.find((w) => w.warehouse.id === warehouseId);

  const m = useMutation({
    mutationFn: () => {
      const base = {
        product_id: row.product_id,
        warehouse_id: warehouseId,
        comment: f.comment || undefined,
        ...(row.unit_tracking && { override_unit_tracking: override, override_reason: f.override_reason.trim() || undefined }),
      };
      const body =
        kind === 'receipt'
          ? { ...base, qty: toInt(f.qty), cost_uzs: showCost ? toInt(f.cost_uzs) : undefined, batch_no: f.batch_no || undefined, expiry_date: f.expiry_date || undefined }
          : kind === 'writeoff'
            ? { ...base, qty: toInt(f.qty), reason: f.reason }
            : kind === 'adjustment'
              ? { ...base, actual_qty: toInt(f.actual_qty), reason: f.reason }
              : { ...base, qty: toInt(f.qty), condition: f.condition, reason: f.reason };
      return api(`/staff/inventory/${kind}`, { method: 'POST', body });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['stock'] });
      void client.invalidateQueries({ queryKey: ['movements'] });
      void client.invalidateQueries({ queryKey: ['products'] });
      onClose();
    },
  });
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };

  return (
    <Modal title={`${OP_TITLE[kind]}: ${row.name_ru}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Склад">
          <select value={warehouseId} onChange={(e) => set('warehouse_id', e.target.value)}>
            {warehouses.data?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="muted small">
          Сейчас на складе: {current?.actual_qty ?? 0}, в резерве {current?.reserved_qty ?? 0}, доступно {current?.available_qty ?? 0}
        </p>
        {kind === 'adjustment' ? (
          <Field label="Фактическое количество по пересчёту" hint="Нельзя меньше количества в резерве">
            <input inputMode="numeric" value={f.actual_qty} onChange={(e) => set('actual_qty', e.target.value)} required />
          </Field>
        ) : (
          <Field label="Количество, шт.">
            <input inputMode="numeric" value={f.qty} onChange={(e) => set('qty', e.target.value)} required />
          </Field>
        )}
        {kind === 'receipt' && (
          <div className="form-grid">
            {showCost && (
              <Field label="Закупочная цена за шт., сум">
                <input inputMode="numeric" value={f.cost_uzs} onChange={(e) => set('cost_uzs', e.target.value)} />
              </Field>
            )}
            <Field label="Номер партии">
              <input value={f.batch_no} onChange={(e) => set('batch_no', e.target.value)} />
            </Field>
            <Field label="Срок годности">
              <input type="date" value={f.expiry_date} onChange={(e) => set('expiry_date', e.target.value)} />
            </Field>
          </div>
        )}
        {kind === 'return' && (
          <Field label="Состояние" hint="Не «годен к продаже» — товар примется и сразу спишется">
            <select value={f.condition} onChange={(e) => set('condition', e.target.value)}>
              {Object.entries(CONDITION).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        )}
        {kind !== 'receipt' && (
          <Field label="Причина (обязательно)">
            <input value={f.reason} onChange={(e) => set('reason', e.target.value)} required />
          </Field>
        )}
        <Field label="Комментарий">
          <input value={f.comment} onChange={(e) => set('comment', e.target.value)} />
        </Field>
        {row.unit_tracking && (
          <div className="alert alert-warn" style={{ display: 'block' }}>
            <p>Товар учитывается по единицам: обычно остаток меняется только через «Приёмка». Операция в обход учёта может развести единицы и остаток (это покажет «Сверка»).</p>
            <label className="check">
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Понимаю, провести в обход учёта по единицам
            </label>
            <Field label="Причина обхода (обязательно)">
              <input value={f.override_reason} onChange={(e) => set('override_reason', e.target.value)} required={override} />
            </Field>
          </div>
        )}
        <ErrorBox error={m.error} />
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn" disabled={m.isPending || !warehouseId || (row.unit_tracking && !override)}>
            Провести
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface MovementRow {
  id: string;
  created_at: string;
  type: string;
  qty: number;
  product: { id: string; sku: string; name_ru: string };
  warehouse: string;
  reason: string | null;
  reference: { type: string; id: string } | null;
  staff_name: string | null;
}

function Movements() {
  const [params, setParams] = useSearchParams();
  const productId = params.get('product_id') ?? '';
  const type = params.get('type') ?? '';
  const page = Number(params.get('page')) || 1;
  const q = useQuery({
    queryKey: ['movements', productId, type, page],
    queryFn: () => api<{ items: MovementRow[]; total: number; total_pages: number }>(`/staff/inventory/movements${qs({ product_id: productId, type, page })}`),
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
      <div className="filters">
        <select value={type} onChange={(e) => set('type', e.target.value)} aria-label="Тип">
          <option value="">Все движения</option>
          {Object.entries(MOVEMENT).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {productId && (
          <button className="btn btn-sm btn-ghost" onClick={() => set('product_id', '')}>
            Показать все товары <CloseIcon />
          </button>
        )}
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : (
        <section className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Товар</th>
                <th>Операция</th>
                <th className="num">Кол-во</th>
                <th>Причина / основание</th>
                <th>Кто</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((m) => (
                <tr key={m.id}>
                  <td>{dateTime(m.created_at)}</td>
                  <td>
                    <Link to={`/inventory?tab=movements&product_id=${m.product.id}`}>{m.product.name_ru}</Link>
                    <div className="muted small">
                      {m.product.sku} · {m.warehouse}
                    </div>
                  </td>
                  <td>{MOVEMENT[m.type] ?? m.type}</td>
                  <td className={`num ${['writeoff', 'deduct', 'reserve'].includes(m.type) || m.qty < 0 ? 'text-bad' : 'text-ok'}`}>{m.qty}</td>
                  <td>
                    {m.reason}
                    {m.reference?.type === 'order' && (
                      <div className="small">
                        <Link to={`/orders/${m.reference.id}`}>заказ</Link>
                      </div>
                    )}
                  </td>
                  <td>{m.staff_name ?? <span className="muted">система / клиент</span>}</td>
                </tr>
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
