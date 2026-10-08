import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useDictionary } from '../components/DictionarySelect';
import { BackIcon } from '../components/Icons';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead, Pagination, toInt } from '../components/ui';
import { api, newKey, qs } from '../lib/api';
import { useSession } from '../lib/auth';
import { dateTime, money } from '../lib/format';

/** Money fields come only with purchases.view_costs (admin); the manager sees quantities. */
interface Progress {
  ordered: number;
  cancelled: number;
  received: number;
  expected: number;
  remaining: number;
  fully_cancelled: boolean;
}
interface PurchaseLine {
  id: string;
  product: { id: string; sku: string; name_ru: string };
  ordered_qty: number;
  cancelled_qty: number;
  received_qty: number;
  remaining_qty: number;
  unit_price_original_uzs?: number;
  base_total_uzs?: number;
  allocated_total_uzs?: number | null;
  unit_cost_uzs?: { min: number; max: number } | null;
}
interface Purchase {
  id: string;
  source_type: 'OZON' | 'SUPPLIER';
  ozon_account: { id: string; name: string } | null;
  supplier: { id: string; name: string } | null;
  ozon_order_number: string | null;
  purchase_date: string;
  status: 'EXPECTED' | 'RECEIVED';
  comment: string | null;
  created_by_name: string | null;
  created_at: string;
  progress: Progress;
  final_actual_total_uzs?: number | null;
  lines_total_uzs?: number;
  difference_uzs?: number | null;
  final_total_missing?: boolean;
  lines: PurchaseLine[];
  lines_count?: number;
  events?: { id: string; type: string; qty: number | null; note: string | null; staff_name: string | null; created_at: string; before: unknown; after: unknown }[];
}

const SOURCE = { OZON: 'Ozon', SUPPLIER: 'Поставщик' } as const;
const EVENT: Record<string, string> = {
  CREATED: 'Создана',
  EDITED: 'Изменена шапка',
  FINAL_TOTAL_SET: 'Итоговая сумма',
  LINE_ADDED: 'Добавлена строка',
  LINE_EDITED: 'Изменена строка',
  LINE_REMOVED: 'Убрана строка',
  CANCELLED: 'Отмена Ozon',
  RECALCULATED: 'Пересчёт себестоимости',
  RECEIVED: 'Получено (приёмка)',
  DISCREPANCY: 'Расхождение при приёмке',
};
const ruDate = (d: string) => d.split('-').reverse().join('.');
const today = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10); // Tashkent
const unitCost = (u: { min: number; max: number } | null | undefined) => (!u ? '—' : u.min === u.max ? money(u.min) : `${money(u.min)} – ${money(u.max)}`);

function StatusBadge({ p }: { p: Pick<Purchase, 'status' | 'progress'> }) {
  if (p.progress.fully_cancelled) return <Badge tone="bad">Отменена полностью</Badge>;
  return p.status === 'RECEIVED' ? <Badge tone="ok">Получено</Badge> : <Badge tone="warn">Ожидается</Badge>;
}
const progressText = (p: Progress) => `${p.received} / ${p.expected}`;

// ---------------------------------------------------------------- list

export function Purchases() {
  const { can } = useSession();
  const costs = can('purchases.view_costs');
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const [cancelOpen, setCancelOpen] = useState(false);
  const accounts = useDictionary('ozon_accounts');
  const suppliers = useDictionary('suppliers');
  const page = Number(params.get('page')) || 1;
  const filters = {
    source_type: params.get('source_type'),
    ozon_account_id: params.get('ozon_account_id'),
    supplier_id: params.get('supplier_id'),
    status: params.get('status'),
    date_from: params.get('date_from'),
    date_to: params.get('date_to'),
    q: params.get('q'),
  };
  const q = useQuery({
    queryKey: ['purchases', params.toString()],
    queryFn: () => api<{ items: Purchase[]; total: number; total_pages: number }>(`/staff/purchases${qs({ ...filters, page })}`),
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
      <PageHead title="Закупки">
        {can('purchases.manage') && (
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setCancelOpen(true)}>
              Отмена Ozon
            </button>
            <Link to="/purchases/new" className="btn">
              + Новая закупка
            </Link>
          </>
        )}
      </PageHead>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          set('q', text);
        }}
      >
        <input placeholder="Номер заказа Ozon — Enter" value={text} onChange={(e) => setText(e.target.value)} />
        <select value={filters.source_type ?? ''} onChange={(e) => set('source_type', e.target.value)} aria-label="Источник">
          <option value="">Все источники</option>
          <option value="OZON">Ozon</option>
          <option value="SUPPLIER">Поставщик</option>
        </select>
        <select value={filters.ozon_account_id ?? ''} onChange={(e) => set('ozon_account_id', e.target.value)} aria-label="Ozon-аккаунт">
          <option value="">Все Ozon-аккаунты</option>
          {accounts.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name_ru}
            </option>
          ))}
        </select>
        <select value={filters.supplier_id ?? ''} onChange={(e) => set('supplier_id', e.target.value)} aria-label="Поставщик">
          <option value="">Все поставщики</option>
          {suppliers.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name_ru}
            </option>
          ))}
        </select>
        <select value={filters.status ?? ''} onChange={(e) => set('status', e.target.value)} aria-label="Статус">
          <option value="">Все статусы</option>
          <option value="EXPECTED">Ожидается</option>
          <option value="RECEIVED">Получено</option>
        </select>
        <input type="date" value={filters.date_from ?? ''} onChange={(e) => set('date_from', e.target.value)} aria-label="С даты" />
        <input type="date" value={filters.date_to ?? ''} onChange={(e) => set('date_to', e.target.value)} aria-label="По дату" />
      </form>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <section className="card flush">
          <table className="table table-hover">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Источник</th>
                <th>Аккаунт / поставщик</th>
                <th>Номер Ozon</th>
                <th className="num">Получено / заказано</th>
                <th>Статус</th>
                {costs && <th className="num">Итоговая сумма</th>}
              </tr>
            </thead>
            <tbody>
              {q.data.items.length === 0 && (
                <tr>
                  <td colSpan={costs ? 7 : 6} className="muted">
                    Закупок нет
                  </td>
                </tr>
              )}
              {q.data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/purchases/${p.id}`} className="strong">
                      {ruDate(p.purchase_date)}
                    </Link>
                  </td>
                  <td>{SOURCE[p.source_type]}</td>
                  <td>{p.ozon_account?.name ?? p.supplier?.name ?? '—'}</td>
                  <td>{p.ozon_order_number ?? <span className="muted">—</span>}</td>
                  <td className="num">{progressText(p.progress)}</td>
                  <td>
                    <StatusBadge p={p} />
                  </td>
                  {costs && (
                    <td className="num">
                      {p.final_actual_total_uzs != null ? money(p.final_actual_total_uzs) : <span className="muted">{money(p.lines_total_uzs ?? 0)} по строкам</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-foot">
            <span className="muted">Всего: {q.data.total}</span>
            <Pagination page={page} totalPages={q.data.total_pages} onPage={(n) => set('page', String(n))} />
          </div>
        </section>
      )}
      {cancelOpen && <OzonCancelModal onClose={() => setCancelOpen(false)} />}
    </>
  );
}

// ---------------------------------------------------------------- «Отмена Ozon»

function OzonCancelModal({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const accounts = useDictionary('ozon_accounts');
  const [accountId, setAccountId] = useState('');
  const [number, setNumber] = useState('');
  const [found, setFound] = useState<Purchase | null>(null);
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('');
  const [key] = useState(newKey);
  const [done, setDone] = useState<PurchaseLine | null>(null);
  const account = accountId || accounts.data?.find((a) => a.status === 'active')?.id || '';

  const find = useMutation({
    mutationFn: () => api<Purchase>(`/staff/purchases/find-ozon${qs({ ozon_account_id: account, ozon_order_number: number.trim() })}`),
    onSuccess: (p) => {
      setFound(p);
      setProductId(p.lines.find((l) => l.remaining_qty > 0)?.product.id ?? '');
    },
  });
  const cancel = useMutation({
    mutationFn: () =>
      api<Purchase>('/staff/purchases/cancel', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: { ozon_account_id: account, ozon_order_number: number.trim(), product_id: productId, cancelled_qty: toInt(qty) },
      }),
    onSuccess: (p) => {
      setFound(p);
      setDone(p.lines.find((l) => l.product.id === productId) ?? null);
      void client.invalidateQueries({ queryKey: ['purchases'] });
      void client.invalidateQueries({ queryKey: ['purchase', p.id] });
    },
  });
  const line = found?.lines.find((l) => l.product.id === productId);

  return (
    <Modal title="Отмена Ozon" onClose={onClose}>
      {done ? (
        <>
          <div className="alert alert-ok">Отмена сохранена</div>
          <p>
            <strong>{done.product.name_ru}</strong> <span className="muted small">{done.product.sku}</span>
          </p>
          <p>
            Заказано: {done.ordered_qty} · Отменено: {done.cancelled_qty} · Осталось: {done.remaining_qty}
          </p>
          <button type="button" className="btn" onClick={onClose}>
            Готово
          </button>
        </>
      ) : !found ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            find.mutate();
          }}
        >
          <Field label="Ozon-аккаунт">
            <select value={account} onChange={(e) => setAccountId(e.target.value)} required>
              {accounts.data?.filter((a) => a.status === 'active').map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name_ru}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Номер заказа Ozon">
            <input value={number} onChange={(e) => setNumber(e.target.value)} required autoFocus />
          </Field>
          <ErrorBox error={find.error} />
          <button className="btn" disabled={find.isPending || !number.trim()}>
            Найти закупку
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (window.confirm(`Отменить ${qty} шт. «${line?.product.name_ru}»?`)) cancel.mutate();
          }}
        >
          <p className="muted">
            Закупка от {ruDate(found.purchase_date)}, {found.ozon_account?.name}, заказ {found.ozon_order_number}
          </p>
          <Field label="Позиция">
            <select value={productId} onChange={(e) => setProductId(e.target.value)} required>
              {found.lines.map((l) => (
                <option key={l.id} value={l.product.id} disabled={l.remaining_qty === 0}>
                  {l.product.name_ru} ({l.product.sku}) — можно отменить {l.remaining_qty}
                </option>
              ))}
            </select>
          </Field>
          {line && (
            <p className="small">
              Заказано: {line.ordered_qty} · Уже отменено: {line.cancelled_qty} · Получено: {line.received_qty} · Осталось: {line.remaining_qty}
            </p>
          )}
          <Field label="Сколько отменить, шт.">
            <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} required />
          </Field>
          <ErrorBox error={cancel.error} />
          <div className="page-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setFound(null)}>
              Назад
            </button>
            <button className="btn btn-danger" disabled={cancel.isPending || !line || !toInt(qty)}>
              Подтвердить отмену
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- creation

interface DraftLine {
  product: { id: string; sku: string; name_ru: string };
  qty: string;
  price: string;
}

interface Preview {
  lines_total_uzs: number;
  final_actual_total_uzs: number | null;
  difference_uzs: number | null;
  final_total_missing: boolean;
  lines: { base_total_uzs: number; allocated_total_uzs: number; unit_cost_uzs: { min: number; max: number } | null }[];
}

export function PurchaseNew() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const accounts = useDictionary('ozon_accounts');
  const suppliers = useDictionary('suppliers');
  const [source, setSource] = useState<'OZON' | 'SUPPLIER'>('OZON');
  const [accountId, setAccountId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [number, setNumber] = useState('');
  const [date, setDate] = useState(today);
  const [comment, setComment] = useState('');
  const [finalTotal, setFinalTotal] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [key] = useState(newKey);

  const valid = lines.length > 0 && lines.every((l) => toInt(l.qty)! > 0 && toInt(l.price) !== undefined);
  const previewBody = useMemo(
    () => ({ lines: lines.map((l) => ({ ordered_qty: toInt(l.qty) ?? 0, unit_price_original_uzs: toInt(l.price) ?? 0 })), final_actual_total_uzs: toInt(finalTotal) ?? null }),
    [lines, finalTotal],
  );
  const preview = useQuery({
    queryKey: ['purchase-preview', JSON.stringify(previewBody)],
    queryFn: () => api<Preview>('/staff/purchases/cost-preview', { method: 'POST', body: previewBody }),
    enabled: valid,
  });
  const save = useMutation({
    mutationFn: () =>
      api<Purchase>('/staff/purchases', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: {
          source_type: source,
          ...(source === 'OZON'
            ? { ozon_account_id: accountId || accounts.data?.find((a) => a.status === 'active')?.id, ozon_order_number: number.trim() }
            : { supplier_id: supplierId || suppliers.data?.find((s) => s.status === 'active')?.id }),
          purchase_date: date,
          comment: comment.trim() || null,
          final_actual_total_uzs: toInt(finalTotal) ?? null,
          lines: lines.map((l) => ({ product_id: l.product.id, ordered_qty: toInt(l.qty), unit_price_original_uzs: toInt(l.price) })),
        },
      }),
    onSuccess: (p) => {
      void client.invalidateQueries({ queryKey: ['purchases'] });
      navigate(`/purchases/${p.id}`, { replace: true });
    },
  });
  const setLine = (i: number, patch: Partial<DraftLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={submit}>
      <PageHead title="Новая закупка">
        <Link to="/purchases" className="btn btn-ghost">
          <BackIcon /> К списку
        </Link>
        <button type="submit" className="btn" disabled={save.isPending || !valid}>
          {save.isPending ? 'Сохранение…' : 'Сохранить закупку'}
        </button>
      </PageHead>
      <ErrorBox error={save.error} />
      <section className="card">
        <h2>Откуда</h2>
        <div className="segmented">
          {(['OZON', 'SUPPLIER'] as const).map((s) => (
            <button key={s} type="button" className={source === s ? 'is-on' : ''} onClick={() => setSource(s)}>
              {SOURCE[s]}
            </button>
          ))}
        </div>
        <div className="form-grid">
          {source === 'OZON' ? (
            <>
              <Field label="Ozon-аккаунт">
                <select value={accountId || accounts.data?.find((a) => a.status === 'active')?.id || ''} onChange={(e) => setAccountId(e.target.value)} required>
                  {accounts.data?.filter((a) => a.status === 'active').map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name_ru}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Номер заказа Ozon">
                <input value={number} onChange={(e) => setNumber(e.target.value)} required />
              </Field>
            </>
          ) : (
            <Field label="Поставщик">
              <select value={supplierId || suppliers.data?.find((s) => s.status === 'active')?.id || ''} onChange={(e) => setSupplierId(e.target.value)} required>
                {suppliers.data?.filter((s) => s.status === 'active').map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name_ru}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Дата закупки">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Итоговая фактическая сумма, сум" hint="Сколько реально заплатили (необязательно). Разница распределится по строкам пропорционально">
            <input inputMode="numeric" value={finalTotal} onChange={(e) => setFinalTotal(e.target.value)} />
          </Field>
        </div>
        <Field label="Комментарий">
          <input value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </section>

      <section className="card">
        <h2>Товары</h2>
        <ProductPicker exclude={lines.map((l) => l.product.id)} onPick={(product) => setLines([...lines, { product, qty: '1', price: '' }])} />
        <table className="table">
          <thead>
            <tr>
              <th>Товар</th>
              <th className="num">Количество</th>
              <th className="num">Цена за шт., сум</th>
              <th className="num">Сумма строки</th>
              <th className="num">Себестоимость шт.</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Добавьте товары: поиск по SKU или названию
                </td>
              </tr>
            )}
            {lines.map((l, i) => (
              <tr key={l.product.id}>
                <td>
                  {l.product.name_ru}
                  <div className="muted small">{l.product.sku}</div>
                </td>
                <td className="num">
                  <input inputMode="numeric" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} required style={{ width: 80 }} />
                </td>
                <td className="num">
                  <input inputMode="numeric" value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} required style={{ width: 120 }} />
                </td>
                <td className="num">{preview.data?.lines[i] ? money(preview.data.lines[i].base_total_uzs) : '—'}</td>
                <td className="num">{preview.data?.lines[i] ? unitCost(preview.data.lines[i].unit_cost_uzs) : '—'}</td>
                <td className="num">
                  <button type="button" className="btn btn-sm btn-ghost text-bad" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                    Убрать
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {preview.data && (
          <p>
            Сумма по строкам: <strong>{money(preview.data.lines_total_uzs)}</strong>
            {preview.data.final_actual_total_uzs != null ? (
              <>
                {' '}
                · Итоговая: <strong>{money(preview.data.final_actual_total_uzs)}</strong> · Разница: <strong>{money(preview.data.difference_uzs ?? 0)}</strong>
              </>
            ) : (
              <span className="muted"> · итоговая сумма не указана, используются цены строк</span>
            )}
          </p>
        )}
        <ErrorBox error={preview.error} />
      </section>
    </form>
  );
}

/** Search a product by SKU or name (archived ones are not offered). */
export function ProductPicker({ exclude, onPick }: { exclude: string[]; onPick: (p: { id: string; sku: string; name_ru: string }) => void }) {
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const q = useQuery({
    queryKey: ['products', 'picker', term],
    queryFn: () => api<{ items: { id: string; sku: string; name_ru: string; status: string }[] }>(`/staff/products${qs({ q: term })}`),
    enabled: term.length >= 2,
  });
  const items = (q.data?.items ?? []).filter((p) => p.status !== 'archived' && !exclude.includes(p.id)).slice(0, 8);
  return (
    <div className="field">
      <input placeholder="Найти товар: SKU или название" value={text} onChange={(e) => setText(e.target.value)} />
      {term.length >= 2 && (
        <div className="card flush">
          {q.isPending && <Loading />}
          {!q.isPending && items.length === 0 && <p className="muted pad">Ничего не найдено</p>}
          {items.map((p) => (
            <button
              key={p.id}
              type="button"
              className="btn btn-ghost"
              style={{ display: 'block', width: '100%', textAlign: 'left' }}
              onClick={() => {
                onPick(p);
                setText('');
              }}
            >
              {p.name_ru} <span className="muted small">{p.sku}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- card

export function PurchaseDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const costs = can('purchases.view_costs');
  const manage = can('purchases.manage');
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['purchase', id], queryFn: () => api<Purchase>(`/staff/purchases/${id}`) });
  const [header, setHeader] = useState<{ date: string; comment: string; total: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const done = (p: Purchase) => {
    client.setQueryData(['purchase', id], p);
    void client.invalidateQueries({ queryKey: ['purchases'] });
  };
  useEffect(() => {
    if (q.data) setHeader({ date: q.data.purchase_date, comment: q.data.comment ?? '', total: q.data.final_actual_total_uzs == null ? '' : String(q.data.final_actual_total_uzs) });
  }, [q.data]);
  const saveHeader = useMutation({
    mutationFn: () =>
      api<Purchase>(`/staff/purchases/${id}`, {
        method: 'PATCH',
        body: { purchase_date: header!.date, comment: header!.comment.trim() || null, ...(costs && { final_actual_total_uzs: toInt(header!.total) ?? null }) },
      }),
    onSuccess: done,
  });
  const lineOp = useMutation({
    mutationFn: ({ line, body }: { line: PurchaseLine; body: object | null }) =>
      body
        ? api<Purchase>(`/staff/purchases/${id}/lines/${line.id}`, { method: 'PATCH', body })
        : api<Purchase>(`/staff/purchases/${id}/lines/${line.id}`, { method: 'DELETE' }),
    onSuccess: done,
  });
  const addLine = useMutation({
    mutationFn: (body: object) => api<Purchase>(`/staff/purchases/${id}/lines`, { method: 'POST', body }),
    onSuccess: (p) => {
      done(p);
      setAddOpen(false);
    },
  });

  if (q.isPending || !header) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;

  return (
    <>
      <PageHead title={`Закупка от ${ruDate(p.purchase_date)}`}>
        <Link to="/purchases" className="btn btn-ghost">
          <BackIcon /> К списку
        </Link>
      </PageHead>
      <ErrorBox error={saveHeader.error ?? lineOp.error} />
      <div className="grid-2">
        <section className="card">
          <div className="section-head">
            <h2>{p.source_type === 'OZON' ? `Ozon · ${p.ozon_account?.name}` : `Поставщик · ${p.supplier?.name}`}</h2>
            <StatusBadge p={p} />
          </div>
          {p.ozon_order_number && <p>Номер заказа Ozon: <strong>{p.ozon_order_number}</strong></p>}
          <p>
            Получено / заказано: <strong>{progressText(p.progress)}</strong>
            {p.progress.cancelled > 0 && <span className="muted"> · отменено {p.progress.cancelled} из {p.progress.ordered}</span>}
          </p>
          {costs && p.progress.received + p.progress.remaining > 0 && (
            <p>
              <Link to={`/inventory?tab=units&purchase_id=${p.id}`}>Единицы (Physical ID) этой закупки →</Link>
            </p>
          )}
          <p className="muted small">
            Создал(а): {p.created_by_name ?? '—'}, {dateTime(p.created_at)}
          </p>
          {costs && (
            <p>
              Сумма по строкам: <strong>{money(p.lines_total_uzs ?? 0)}</strong>
              {p.final_actual_total_uzs != null ? (
                <>
                  {' '}
                  · Итоговая: <strong>{money(p.final_actual_total_uzs)}</strong> · Разница: <strong>{money(p.difference_uzs ?? 0)}</strong>
                </>
              ) : (
                p.final_total_missing && <span className="muted"> · итоговая сумма не указана, используются цены строк</span>
              )}
            </p>
          )}
        </section>
        <section className="card">
          <h2>Шапка</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveHeader.mutate();
            }}
          >
            <div className="form-grid">
              <Field label="Дата закупки">
                <input type="date" value={header.date} disabled={!manage} onChange={(e) => setHeader({ ...header, date: e.target.value })} required />
              </Field>
              {costs && (
                <Field label="Итоговая фактическая сумма, сум" hint="Пусто — используются цены строк">
                  <input inputMode="numeric" value={header.total} disabled={!manage} onChange={(e) => setHeader({ ...header, total: e.target.value })} />
                </Field>
              )}
            </div>
            <Field label="Комментарий">
              <input value={header.comment} disabled={!manage} onChange={(e) => setHeader({ ...header, comment: e.target.value })} />
            </Field>
            {manage && (
              <button className="btn" disabled={saveHeader.isPending}>
                Сохранить
              </button>
            )}
          </form>
        </section>
      </div>

      <section className="card flush">
        <div className="section-head pad">
          <h2>Строки</h2>
          {manage && (
            <button type="button" className="btn btn-ghost" onClick={() => setAddOpen(true)}>
              + Добавить товар
            </button>
          )}
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Товар</th>
              <th className="num">Заказано</th>
              <th className="num">Отменено</th>
              <th className="num">Получено</th>
              <th className="num">Осталось ждать</th>
              {costs && <th className="num">Цена за шт.</th>}
              {costs && <th className="num">Себестоимость шт.</th>}
              {manage && <th />}
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l) => (
              <tr key={l.id}>
                <td>
                  <Link to={`/products/${l.product.id}`}>{l.product.name_ru}</Link>
                  <div className="muted small">{l.product.sku}</div>
                </td>
                <td className="num">{l.ordered_qty}</td>
                <td className="num">{l.cancelled_qty}</td>
                <td className="num">{l.received_qty}</td>
                <td className="num">{l.remaining_qty}</td>
                {costs && <td className="num">{money(l.unit_price_original_uzs ?? 0)}</td>}
                {costs && <td className="num">{unitCost(l.unit_cost_uzs)}</td>}
                {manage && (
                  <td className="num">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        const v = window.prompt(`Заказано, шт. (не меньше ${l.cancelled_qty + l.received_qty})`, String(l.ordered_qty));
                        if (v && toInt(v)) lineOp.mutate({ line: l, body: { ordered_qty: toInt(v) } });
                      }}
                    >
                      Количество
                    </button>
                    {costs && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          const v = window.prompt('Цена за штуку, сум', String(l.unit_price_original_uzs ?? ''));
                          if (v !== null && toInt(v) !== undefined) lineOp.mutate({ line: l, body: { unit_price_original_uzs: toInt(v) } });
                        }}
                      >
                        Цена
                      </button>
                    )}
                    {l.received_qty === 0 && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost text-bad"
                        onClick={() => window.confirm(`Убрать «${l.product.name_ru}» из закупки?`) && lineOp.mutate({ line: l, body: null })}
                      >
                        Убрать
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>История</h2>
        <table className="table">
          <tbody>
            {p.events?.map((e) => (
              <tr key={e.id}>
                <td className="muted small">{dateTime(e.created_at)}</td>
                <td>
                  {EVENT[e.type] ?? e.type}
                  {e.qty != null && <span className="muted"> · {e.qty} шт.</span>}
                  {e.note && <div className="muted small">{e.note}</div>}
                </td>
                <td className="muted small">{e.staff_name ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {addOpen && <AddLineModal costs={costs} exclude={p.lines.map((l) => l.product.id)} pending={addLine.isPending} error={addLine.error} onAdd={(b) => addLine.mutate(b)} onClose={() => setAddOpen(false)} />}
    </>
  );
}

function AddLineModal({
  costs,
  exclude,
  pending,
  error,
  onAdd,
  onClose,
}: {
  costs: boolean;
  exclude: string[];
  pending: boolean;
  error: unknown;
  onAdd: (body: object) => void;
  onClose: () => void;
}) {
  const [product, setProduct] = useState<{ id: string; sku: string; name_ru: string } | null>(null);
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  return (
    <Modal title="Добавить товар в закупку" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (product) onAdd({ product_id: product.id, ordered_qty: toInt(qty), unit_price_original_uzs: toInt(price) ?? 0 });
        }}
      >
        {product ? (
          <p>
            <strong>{product.name_ru}</strong> <span className="muted small">{product.sku}</span>{' '}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setProduct(null)}>
              Другой
            </button>
          </p>
        ) : (
          <ProductPicker exclude={exclude} onPick={setProduct} />
        )}
        <div className="form-grid">
          <Field label="Количество, шт.">
            <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} required />
          </Field>
          {costs && (
            <Field label="Цена за шт., сум">
              <input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} required />
            </Field>
          )}
        </div>
        <ErrorBox error={error} />
        <button className="btn" disabled={pending || !product || !toInt(qty)}>
          Добавить
        </button>
      </form>
    </Modal>
  );
}
