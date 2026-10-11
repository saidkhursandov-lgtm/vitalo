import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BackIcon } from '../components/Icons';
import { REASONS, ReasonPicker } from '../components/Reason';
import { Badge, ErrorBox, Field, Loading, Modal, Pagination } from '../components/ui';
import { api, ApiError, newKey, qs } from '../lib/api';
import { useSession } from '../lib/auth';
import { dateTime, money, ruDate, UNIT_EVENT, UNIT_STATUS } from '../lib/format';

/**
 * Stage 2B warehouse screens (Склад → Приёмка / Единицы / Сверка). The server leaves out unit costs, purchase
 * prices and Ozon order numbers for manager and warehouse; the screens show only what comes.
 */

interface Source {
  type: 'OZON' | 'SUPPLIER' | 'OPENING_BALANCE';
  id: string | null;
  name: string;
}

export interface Unit {
  id: string;
  physical_id: string;
  product: { id: string; sku: string; name_ru: string };
  expiry_date: string;
  status: string;
  receiving_session_id: string;
  label_print_count: number;
  last_printed_at: string | null;
  created_at: string;
  actual_cost_uzs?: number;
  purchase?: { id: string; source_type: string; ozon_order_number: string | null; purchase_date: string } | null;
}

interface Session {
  id: string;
  type: 'PURCHASE' | 'OPENING_BALANCE';
  status: 'OPEN' | 'COMPLETED' | 'CANCELLED';
  source: Source;
  created_by_name: string | null;
  created_at: string;
  completed_at: string | null;
  lines: { id: string; product: { sku: string; name_ru: string }; qty: number; discrepancy_qty: number | null }[];
  units: Unit[];
  summary: { units: number; printed: number; discrepancy_qty: number };
  created?: string[];
  warnings?: string[];
  replayed?: boolean;
}

interface Expected {
  product: { id: string; sku: string; name_ru: string };
  remaining_qty: number;
  accepted_qty: number;
  open_qty: number;
  purchases?: { id: string; ozon_order_number: string | null; purchase_date: string; remaining_qty: number }[];
}

const SESSION_STATUS: Record<string, [string, 'warn' | 'ok' | 'neutral']> = {
  OPEN: ['Не завершена', 'warn'],
  COMPLETED: ['Завершена', 'ok'],
  CANCELLED: ['Отменена', 'neutral'],
};
const sourceTitle = (s: Source) => (s.type === 'OZON' ? `Ozon · ${s.name}` : s.type === 'SUPPLIER' ? `Поставщик · ${s.name}` : 'Начальный остаток');

type PrintScope = { session_id: string } | { unit_ids: string[] };

/**
 * «Напечатать этикетки»: a link to the label page with a print ticket in the #fragment (never the staff token).
 * The ticket allows only these labels for 15 minutes; it is renewed every 5 minutes, so the link always has time
 * left. In Telegram the page opens in the external browser (Chrome): it does not need the Telegram sign-in.
 */
function PrintLink({ scope, className = 'btn', onOpen, children }: { scope: PrintScope; className?: string; onOpen?: () => void; children: ReactNode }) {
  const q = useQuery({
    queryKey: ['print-ticket', scope],
    queryFn: () => api<{ ticket: string; expires_at: string }>('/staff/units/labels/ticket', { method: 'POST', body: scope }),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
  const url = q.data ? `/print/labels#t=${encodeURIComponent(q.data.ticket)}` : undefined;
  return (
    <>
      <a
        className={className}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-disabled={!url}
        onClick={(e) => {
          if (!url) return e.preventDefault();
          const tg = window.Telegram?.WebApp;
          if (tg?.initData && tg.openLink) {
            e.preventDefault();
            tg.openLink(new URL(url, window.location.href).href);
          }
          onOpen?.();
        }}
      >
        {children}
      </a>
      {q.error && <ErrorBox error={q.error} onRetry={() => void q.refetch()} />}
    </>
  );
}

/** Test print with the label size from the settings (the page itself needs no sign-in: fake data only). */
function TestPrintLink() {
  const size = useQuery({ queryKey: ['label-size'], queryFn: () => api<{ width_mm: number; height_mm: number }>('/staff/units/labels/size'), staleTime: 60_000 });
  const href = size.data ? `/print/test?w=${size.data.width_mm}&h=${size.data.height_mm}` : '/print/test';
  return (
    <a className="btn btn-sm btn-ghost" href={href} target="_blank" rel="noopener noreferrer">
      Тестовая печать этикетки
    </a>
  );
}

/** «31122027» / «31.12.2027» while typing -> «31.12.2027». */
export function maskDate(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 8);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join('.');
}
const validDate = (v: string) => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return d.getUTCDate() === +m[1] && d.getUTCMonth() === +m[2] - 1;
};

// ====================================================================== Приёмка

export function Receiving() {
  const [params, setParams] = useSearchParams();
  const sessionId = params.get('session');
  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('session', id);
    else next.delete('session');
    setParams(next);
  };
  return sessionId ? <SessionScreen key={sessionId} id={sessionId} onExit={() => open(null)} /> : <ReceivingStart onOpen={open} />;
}

function ReceivingStart({ onOpen }: { onOpen: (id: string) => void }) {
  const sources = useQuery({ queryKey: ['receiving-sources'], queryFn: () => api<{ ozon_accounts: SourceRow[]; suppliers: SourceRow[] }>('/staff/receiving/sources') });
  const start = useMutation({
    mutationFn: (body: object) => api<Session>('/staff/receiving/sessions', { method: 'POST', body }),
    onSuccess: (s) => onOpen(s.id),
  });
  return (
    <>
      <Unfinished onOpen={onOpen} />
      <section className="card">
        <div className="section-head">
          <h2>Новая приёмка: откуда пришёл товар?</h2>
          <TestPrintLink />
        </div>
        <ErrorBox error={start.error} />
        {sources.isPending ? (
          <Loading />
        ) : sources.isError ? (
          <ErrorBox error={sources.error} onRetry={() => void sources.refetch()} />
        ) : (
          <>
            <h3>Ozon-аккаунты</h3>
            <SourceButtons rows={sources.data.ozon_accounts} busy={start.isPending} onPick={(id) => start.mutate({ ozon_account_id: id })} />
            <h3>Поставщики</h3>
            <SourceButtons rows={sources.data.suppliers} busy={start.isPending} onPick={(id) => start.mutate({ supplier_id: id })} />
          </>
        )}
      </section>
    </>
  );
}

interface SourceRow {
  id: string;
  name: string;
  expected_qty: number;
  open_session_id: string | null;
}

function SourceButtons({ rows, busy, onPick }: { rows: SourceRow[]; busy: boolean; onPick: (id: string) => void }) {
  if (!rows.length) return <p className="muted">Нет активных.</p>;
  return (
    <div className="source-grid">
      {rows.map((r) => (
        <button key={r.id} className="source-btn" disabled={busy} onClick={() => onPick(r.id)}>
          <strong>{r.name}</strong>
          <span className={r.expected_qty ? '' : 'muted'}>{r.expected_qty ? `ожидается ${r.expected_qty} шт.` : 'ничего не ожидается'}</span>
          {r.open_session_id && <Badge tone="warn">есть незавершённая приёмка</Badge>}
        </button>
      ))}
    </div>
  );
}

function Unfinished({ onOpen }: { onOpen: (id: string) => void }) {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['receiving-sessions', 'OPEN'], queryFn: () => api<(Omit<Session, 'units' | 'lines' | 'summary'> & { units_count: number })[]>('/staff/receiving/sessions') });
  const [cancel, setCancel] = useState<string | null>(null);
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data.length) return null;
  return (
    <section className="card flush">
      <div className="card-head">
        <h2>Незавершённые приёмки</h2>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Откуда</th>
            <th>Начата</th>
            <th className="num">Единиц</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {q.data.map((s) => {
            const mayClose = s.type !== 'OPENING_BALANCE' || can('receiving.opening');
            return (
              <tr key={s.id}>
                <td>
                  <strong>{sourceTitle(s.source)}</strong>
                </td>
                <td>
                  {dateTime(s.created_at)}
                  <div className="muted small">{s.created_by_name ?? 'скрипт'}</div>
                </td>
                <td className="num">{s.units_count}</td>
                <td className="ops">
                  <button className="btn" onClick={() => onOpen(s.id)}>
                    Продолжить
                  </button>
                  {mayClose && (
                    <button className="btn btn-danger" onClick={() => setCancel(s.id)}>
                      Отменить
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {cancel && <CancelModal id={cancel} onClose={() => setCancel(null)} />}
    </section>
  );
}

function CancelModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone?: () => void }) {
  const client = useQueryClient();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/staff/receiving/sessions/${id}/cancel`, { method: 'POST', body: { reason: reason.trim() || undefined } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['receiving-sessions'] });
      void client.invalidateQueries({ queryKey: ['receiving-session', id] });
      void client.invalidateQueries({ queryKey: ['receiving-sources'] });
      onClose();
      onDone?.();
    },
  });
  return (
    <Modal title="Отменить приёмку?" onClose={onClose}>
      <p>Созданные Physical ID станут «Отменена». Их номера больше не используются; остаток на складе не меняется.</p>
      <Field label="Причина (необязательно)">
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorBox error={m.error} />
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Не отменять
        </button>
        <button className="btn btn-danger" disabled={m.isPending} onClick={() => m.mutate()}>
          Отменить приёмку
        </button>
      </div>
    </Modal>
  );
}

function SessionScreen({ id, onExit }: { id: string; onExit: () => void }) {
  const { can } = useSession();
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['receiving-session', id], queryFn: () => api<Session>(`/staff/receiving/sessions/${id}`) });
  const s = q.data;
  const srcQuery = s?.source.type === 'OZON' ? { ozon_account_id: s.source.id } : s?.source.type === 'SUPPLIER' ? { supplier_id: s.source.id } : null;
  const expected = useQuery({
    queryKey: ['receiving-expected', id, srcQuery],
    queryFn: () => api<{ items: Expected[] }>(`/staff/receiving/expected${qs(srcQuery!)}`),
    enabled: !!srcQuery && s?.status === 'OPEN',
  });
  const [accepting, setAccepting] = useState<Expected | null>(null);
  const [printed, setPrinted] = useState<'no' | 'asked' | 'yes'>('no');
  const [cancel, setCancel] = useState(false);
  const [completeKey] = useState(newKey);
  const complete = useMutation({
    mutationFn: () => api<Session>(`/staff/receiving/sessions/${id}/complete`, { method: 'POST', headers: { 'Idempotency-Key': completeKey } }),
    onSuccess: (res) => {
      client.setQueryData(['receiving-session', id], res);
      void client.invalidateQueries({ queryKey: ['receiving-sessions'] });
      void client.invalidateQueries({ queryKey: ['receiving-sources'] });
      void client.invalidateQueries({ queryKey: ['stock'] });
    },
  });

  if (q.isPending) return <Loading />;
  if (q.isError || !s) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const [statusText, tone] = SESSION_STATUS[s.status];
  const live = s.units.filter((u) => u.status !== 'VOIDED');
  const mayComplete = s.type === 'PURCHASE' || can('receiving.opening');
  const step = s.status !== 'OPEN' ? 4 : !live.length ? 1 : printed !== 'yes' ? 2 : 3;

  return (
    <>
      <div className="section-head">
        <h2>
          {sourceTitle(s.source)} <Badge tone={tone}>{statusText}</Badge>
        </h2>
        <button className="btn btn-ghost" onClick={onExit}>
          <BackIcon /> К приёмкам
        </button>
      </div>
      <div className="steps">
        {['1. Принять товар', '2. Этикетки', '3. Завершить'].map((t, i) => (
          <span key={t} className={`step ${step === i + 1 ? 'is-on' : step > i + 1 ? 'is-done' : ''}`}>
            {t}
          </span>
        ))}
      </div>

      {s.status === 'COMPLETED' && (
        <div className="alert alert-ok">
          Приёмка завершена {dateTime(s.completed_at)}: {live.length} шт. на складе.
          <button className="btn btn-sm btn-ghost" onClick={onExit}>
            Новая приёмка
          </button>
        </div>
      )}
      {s.status === 'CANCELLED' && <div className="alert alert-info">Приёмка отменена: её единицы получили статус «Отменена».</div>}

      {s.status === 'OPEN' && s.type === 'PURCHASE' && (
        <section className="card flush">
          <div className="card-head">
            <h2>Ожидаемые позиции</h2>
            <p className="muted small">Нажмите «Принять» у пришедшего товара</p>
          </div>
          {expected.isPending ? (
            <div className="pad">
              <Loading />
            </div>
          ) : expected.isError ? (
            <ErrorBox error={expected.error} />
          ) : !expected.data.items.length ? (
            <p className="pad muted">По этому источнику ничего не ожидается.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th className="num">Ожидается</th>
                  <th className="num">Принято сейчас</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {expected.data.items.map((it) => (
                  <tr key={it.product.id}>
                    <td>
                      <strong>{it.product.sku}</strong> · {it.product.name_ru}
                      {it.purchases && (
                        <div className="muted small">
                          {it.purchases.map((p) => `${ruDate(p.purchase_date)}${p.ozon_order_number ? ` (${p.ozon_order_number})` : ''}: ${p.remaining_qty}`).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="num strong">{it.remaining_qty}</td>
                    <td className="num">{it.accepted_qty || ''}</td>
                    <td>
                      <button className="btn btn-lg" onClick={() => setAccepting(it)}>
                        Принять
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="card">
        <div className="section-head">
          <h2>Созданные Physical ID: {live.length}</h2>
          {s.status !== 'CANCELLED' && live.length > 0 && (
            <PrintLink
              className="btn btn-lg"
              scope={{ session_id: s.id }}
              onOpen={() => {
                setPrinted('asked');
                window.setTimeout(() => void q.refetch(), 1500);
              }}
            >
              Напечатать этикетки
            </PrintLink>
          )}
        </div>
        {!live.length ? (
          <p className="muted">{s.type === 'PURCHASE' ? 'Пока ничего не принято.' : 'Единиц нет.'}</p>
        ) : (
          <>
            <p className="muted small">
              Этикетки напечатаны для {s.summary.printed} из {s.summary.units}
              {s.summary.discrepancy_qty > 0 && <span className="text-warn"> · расхождение: +{s.summary.discrepancy_qty} шт. сверх ожидаемого</span>}
            </p>
            <UnitTable units={live} />
          </>
        )}
        {s.status === 'OPEN' && printed === 'asked' && (
          <div className="alert alert-info">
            Этикетки напечатаны и наклеены?
            <span>
              <button className="btn btn-sm" onClick={() => setPrinted('yes')}>
                Да, наклеены
              </button>{' '}
              <button className="btn btn-sm btn-ghost" onClick={() => setPrinted('no')}>
                Нет
              </button>
            </span>
          </div>
        )}
      </section>

      {s.status === 'OPEN' && (
        <section className="card">
          <ErrorBox error={complete.error} />
          {!mayComplete && <p className="muted">Начальный остаток завершает администратор.</p>}
          <div className="page-actions">
            <button className="btn btn-lg" disabled={!mayComplete || !live.length || printed !== 'yes' || complete.isPending} onClick={() => complete.mutate()}>
              Завершить приёмку
            </button>
            {mayComplete && (
              <button className="btn btn-danger" onClick={() => setCancel(true)}>
                Отменить приёмку
              </button>
            )}
          </div>
          {live.length > 0 && printed !== 'yes' && <p className="muted small">«Завершить» станет доступно после ответа «Да, наклеены».</p>}
          {s.type === 'OPENING_BALANCE' && (
            <p className="muted small">При завершении остаток товаров станет равен числу единиц (корректировка), и товары перейдут на учёт по единицам.</p>
          )}
        </section>
      )}

      {accepting && srcQuery && (
        <AcceptModal
          sessionId={s.id}
          item={accepting}
          onClose={() => setAccepting(null)}
          onDone={(res) => {
            client.setQueryData(['receiving-session', id], res);
            void client.invalidateQueries({ queryKey: ['receiving-expected', id] });
            setAccepting(null);
            setPrinted('no');
          }}
        />
      )}
      {cancel && <CancelModal id={s.id} onClose={() => setCancel(false)} onDone={() => void q.refetch()} />}
    </>
  );
}

function AcceptModal({ sessionId, item, onClose, onDone }: { sessionId: string; item: Expected; onClose: () => void; onDone: (s: Session) => void }) {
  const [qty, setQty] = useState(String(item.open_qty || item.remaining_qty || 1));
  const [groups, setGroups] = useState([{ expiry: '', qty: '' }]);
  const [key] = useState(newKey);
  const [confirm, setConfirm] = useState<{ message: string; flags: Record<string, boolean> } | null>(null);
  const [result, setResult] = useState<Session | null>(null);
  const n = Number(qty) || 0;
  // one group: its quantity is the whole quantity
  const filled = groups.length === 1 ? [{ ...groups[0], qty: String(n) }] : groups;
  const sum = filled.reduce((s, g) => s + (Number(g.qty) || 0), 0);
  const datesOk = filled.every((g) => validDate(g.expiry));

  const m = useMutation({
    mutationFn: (flags: Record<string, boolean>) =>
      api<Session>(`/staff/receiving/sessions/${sessionId}/accept`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: { product_id: item.product.id, qty: n, expiry_groups: filled.map((g) => ({ expiry: g.expiry, qty: Number(g.qty) })), ...flags },
      }),
    onSuccess: (res) => {
      setConfirm(null);
      setResult(res);
    },
    onError: (e, flags) => {
      if (e instanceof ApiError && (e.code === 'SHORT_EXPIRY' || e.code === 'OVER_EXPECTED')) {
        const flag = e.code === 'SHORT_EXPIRY' ? 'confirm_short_expiry' : 'confirm_over_expected';
        setConfirm({ message: e.message, flags: { ...flags, [flag]: true } });
      }
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate({});
  };

  if (result) {
    return (
      <Modal title="Physical ID созданы" onClose={() => onDone(result)}>
        <p>
          {item.product.sku}: создано <strong>{result.created?.length ?? 0}</strong> шт.
        </p>
        <div className="id-list">
          {result.created?.map((pid) => (
            <span key={pid} className="id-chip">
              {pid}
            </span>
          ))}
        </div>
        {result.warnings?.map((w) => (
          <div key={w} className="alert alert-warn" style={{ marginTop: 12 }}>
            {w}
          </div>
        ))}
        <div className="modal-actions">
          <button className="btn btn-lg" onClick={() => onDone(result)}>
            Готово
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Принять: ${item.product.sku}`} onClose={onClose} wide>
      <p className="muted">
        {item.product.name_ru} · ожидается {item.remaining_qty} шт.{item.accepted_qty ? `, уже принято ${item.accepted_qty}` : ''}
      </p>
      <form onSubmit={submit}>
        <Field label="Сколько банок пришло фактически">
          <input className="scan-input" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} autoFocus required />
        </Field>
        <h3>Срок годности (ДД.ММ.ГГГГ)</h3>
        {groups.map((g, i) => (
          <div key={i} className="expiry-row">
            <Field label={groups.length > 1 ? `Срок ${i + 1}` : 'Срок годности'}>
              <input
                inputMode="numeric"
                placeholder="31.12.2027"
                value={g.expiry}
                onChange={(e) => setGroups(groups.map((x, k) => (k === i ? { ...x, expiry: maskDate(e.target.value) } : x)))}
                required
              />
            </Field>
            {groups.length > 1 ? (
              <>
                <Field label="Банок">
                  <input inputMode="numeric" value={g.qty} onChange={(e) => setGroups(groups.map((x, k) => (k === i ? { ...x, qty: e.target.value.replace(/\D/g, '') } : x)))} required />
                </Field>
                <button type="button" className="btn btn-ghost btn-icon" aria-label="Убрать срок" onClick={() => setGroups(groups.filter((_, k) => k !== i))} style={{ marginBottom: 12 }}>
                  ×
                </button>
              </>
            ) : (
              <span />
            )}
          </div>
        ))}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setGroups([...groups.map((g) => ({ ...g, qty: groups.length === 1 ? String(n) : g.qty })), { expiry: '', qty: '' }])}>
          + Другой срок годности
        </button>
        {groups.length > 1 && (
          <p className={sum === n ? 'text-ok small' : 'text-bad small'}>
            По срокам: {sum} из {n}
          </p>
        )}
        {n > item.open_qty && item.open_qty >= 0 && (
          <div className="alert alert-warn" style={{ marginTop: 12 }}>
            Ожидается ещё {item.open_qty} шт. — {n - item.open_qty} шт. сверх ожидаемого будут записаны как расхождение.
          </div>
        )}
        <ErrorBox error={confirm ? null : m.error} />
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn btn-lg" disabled={m.isPending || n < 1 || sum !== n || !datesOk}>
            Создать Physical ID
          </button>
        </div>
      </form>
      {confirm && (
        <Modal title="Подтвердите" onClose={() => setConfirm(null)}>
          <p>{confirm.message}</p>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
              Нет, исправить
            </button>
            <button className="btn" disabled={m.isPending} onClick={() => m.mutate(confirm.flags)}>
              Да, принять
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

/** At most this many labels in one print (the server limit of a print ticket for single units). */
export const REPRINT_MAX = 50;
/** A cancelled unit has no label: it cannot be chosen. */
export const printable = (u: Pick<Unit, 'status'>) => u.status !== 'VOIDED';

/** Check boxes for «Напечатать этикетки выбранных» (the «Единицы» tab); without `select` the table is as before. */
export interface UnitSelection {
  ids: Set<string>;
  toggle: (id: string) => void;
  /** all printable units of the page on / off */
  toggleAll: () => void;
}

export function UnitTable({ units, onOpen, select }: { units: Unit[]; onOpen?: (u: Unit) => void; select?: UnitSelection }) {
  const choosable = units.filter(printable);
  const all = choosable.length > 0 && choosable.every((u) => select?.ids.has(u.id));
  return (
    <table className={`table ${onOpen ? 'table-hover' : ''}`}>
      <thead>
        <tr>
          {select && (
            <th style={{ width: 36 }}>
              <input type="checkbox" aria-label="Выбрать все на странице" checked={all} disabled={!choosable.length} onChange={select.toggleAll} />
            </th>
          )}
          <th>Physical ID</th>
          <th>Товар</th>
          <th>Срок годности</th>
          <th>Статус</th>
          <th className="num">Этикеток</th>
        </tr>
      </thead>
      <tbody>
        {units.map((u) => (
          <tr key={u.id} onClick={onOpen && (() => onOpen(u))} style={onOpen && { cursor: 'pointer' }}>
            {select && (
              // the cell itself does not open the card: a click next to the small box must not surprise
              <td onClick={(e) => e.stopPropagation()} style={{ cursor: 'default' }}>
                <input
                  type="checkbox"
                  aria-label={`Выбрать ${u.physical_id}`}
                  checked={select.ids.has(u.id)}
                  disabled={!printable(u)}
                  title={printable(u) ? undefined : 'Отменённая единица: этикетка не печатается'}
                  onChange={() => select.toggle(u.id)}
                />
              </td>
            )}
            <td>
              <span className="id-chip">{u.physical_id}</span>
            </td>
            <td>
              <strong>{u.product.sku}</strong>
              <div className="muted small">{u.product.name_ru}</div>
            </td>
            <td>{ruDate(u.expiry_date)}</td>
            <td>
              <Badge tone={u.status === 'IN_STOCK' ? 'ok' : u.status === 'VOIDED' ? 'neutral' : 'warn'}>{UNIT_STATUS[u.status] ?? u.status}</Badge>
            </td>
            <td className="num">{u.label_print_count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ====================================================================== Единицы

interface UnitCard extends Unit {
  events: { id: string; type: string; from_status: string | null; to_status: string | null; note: string | null; staff_name: string | null; created_at: string; reference: { type: string; id: string } | null }[];
}

export function Units() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page')) || 1;
  const status = params.get('status') ?? '';
  const purchaseId = params.get('purchase_id') ?? '';
  const [code, setCode] = useState('');
  const [card, setCard] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // «Напечатать этикетки выбранных»: the choice lives while the same page of the same list is shown
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [printedNote, setPrintedNote] = useState<string | null>(null);
  useEffect(() => setChosen(new Set()), [status, purchaseId, page]);
  const list = useQuery({
    queryKey: ['units', status, purchaseId, page],
    queryFn: () => api<{ items: Unit[]; total: number; total_pages: number }>(`/staff/units${qs({ status, purchase_id: purchaseId, page })}`),
  });
  const find = useMutation({
    mutationFn: (c: string) => api<UnitCard>(`/staff/units/find${qs({ code: c })}`),
    onSuccess: (u) => {
      setCard(u.id);
      setCode('');
    },
    onSettled: () => input.current?.focus(),
  });
  useEffect(() => input.current?.focus(), []);
  const pageUnits = list.data?.items ?? [];
  const chosenIds = pageUnits.filter((u) => chosen.has(u.id) && printable(u)).map((u) => u.id);
  const selection: UnitSelection = {
    ids: chosen,
    toggle: (id) =>
      setChosen((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    toggleAll: () =>
      setChosen((cur) => {
        const ids = pageUnits.filter(printable).map((u) => u.id);
        return ids.every((id) => cur.has(id)) ? new Set() : new Set(ids);
      }),
  };
  /**
   * The same print as «Напечатать этикетку» of one unit, for the chosen ones: a print ticket for these units and the
   * label page in a new tab. Prints existing units only: nothing is created, the stock and the IDs do not change.
   */
  const reprint = useMutation({
    mutationFn: async (ids: string[]) => {
      const tg = window.Telegram?.WebApp;
      const inTelegram = !!(tg?.initData && tg.openLink);
      // the tab is opened at once, inside the click (a browser blocks a window opened after waiting for the server)
      const tab = inTelegram ? null : window.open('about:blank', '_blank');
      try {
        const { ticket } = await api<{ ticket: string }>('/staff/units/labels/ticket', { method: 'POST', body: { unit_ids: ids } });
        const url = new URL(`/print/labels#t=${encodeURIComponent(ticket)}`, window.location.href).href;
        if (inTelegram) tg!.openLink!(url);
        else if (tab) tab.location.href = url;
        else throw new Error('Браузер не дал открыть вкладку печати: разрешите всплывающие окна для админки и нажмите ещё раз');
        return ids.length;
      } catch (e) {
        tab?.close();
        throw e;
      }
    },
    onSuccess: (n) => {
      setPrintedNote(`Открыта печать этикеток: ${n} шт. Новые банки не создаются, остатки не меняются; счётчик «Этикеток» обновится после печати.`);
      setChosen(new Set());
      window.setTimeout(() => void list.refetch(), 2500);
    },
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
      <PendingReturns onOpen={setCard} />
      <section className="card">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) find.mutate(code.trim());
          }}
        >
          <Field label="Physical ID — введите или отсканируйте и нажмите Enter" hint="Подходит V-000184, v-000184, 000184 или просто 184">
            <input ref={input} className="scan-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="V-000184" autoComplete="off" />
          </Field>
        </form>
        <ErrorBox error={find.error} />
      </section>
      <div className="filters">
        <select value={status} onChange={(e) => set('status', e.target.value)} aria-label="Статус">
          <option value="">Все статусы</option>
          {Object.entries(UNIT_STATUS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {purchaseId && (
          <button className="btn btn-sm btn-ghost" onClick={() => set('purchase_id', '')}>
            Только единицы закупки × показать все
          </button>
        )}
        <button className="btn" disabled={!chosenIds.length || chosenIds.length > REPRINT_MAX || reprint.isPending} onClick={() => reprint.mutate(chosenIds)}>
          Напечатать этикетки выбранных{chosenIds.length ? ` (${chosenIds.length})` : ''}
        </button>
        {chosenIds.length > 0 && (
          <button className="btn btn-sm btn-ghost" onClick={() => setChosen(new Set())}>
            Снять выбор
          </button>
        )}
        <span className="muted small">Отметьте банки галочками (или верхней галочкой — все на странице). До {REPRINT_MAX} этикеток за раз.</span>
      </div>
      <ErrorBox error={reprint.error} />
      {printedNote && <div className="alert alert-ok">{printedNote}</div>}
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorBox error={list.error} />
      ) : (
        <section className="card flush">
          <UnitTable units={list.data.items} onOpen={(u) => setCard(u.id)} select={selection} />
          <div className="table-foot">
            <span className="muted">Единиц: {list.data.total}</span>
            <Pagination page={page} totalPages={list.data.total_pages} onPage={(p) => set('page', String(p))} />
          </div>
        </section>
      )}
      {card && (
        <UnitCardModal
          id={card}
          onClose={() => {
            setCard(null);
            input.current?.focus();
          }}
        />
      )}
    </>
  );
}

function UnitCardModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['unit', id], queryFn: () => api<UnitCard>(`/staff/units/${id}`) });
  const u = q.data;
  const [action, setAction] = useState<UnitAction | null>(null);
  return (
    <Modal title={u ? `Единица ${u.physical_id}` : 'Единица'} onClose={onClose} wide>
      {q.isPending ? (
        <Loading />
      ) : q.isError || !u ? (
        <ErrorBox error={q.error} />
      ) : (
        <>
          <dl className="props">
            <dt>Товар</dt>
            <dd>
              <Link to={`/products/${u.product.id}`}>{u.product.sku}</Link> · {u.product.name_ru}
            </dd>
            <dt>Срок годности</dt>
            <dd>{ruDate(u.expiry_date)}</dd>
            <dt>Статус</dt>
            <dd>{UNIT_STATUS[u.status] ?? u.status}</dd>
            <dt>Этикетка</dt>
            <dd>{u.label_print_count ? `напечатана ${u.label_print_count} раз, последний ${dateTime(u.last_printed_at)}` : 'не печаталась'}</dd>
            {u.actual_cost_uzs !== undefined && (
              <>
                <dt>Себестоимость</dt>
                <dd>{money(u.actual_cost_uzs)}</dd>
              </>
            )}
            {u.purchase && (
              <>
                <dt>Закупка</dt>
                <dd>
                  <Link to={`/purchases/${u.purchase.id}`}>
                    от {ruDate(u.purchase.purchase_date)}
                    {u.purchase.ozon_order_number ? `, Ozon ${u.purchase.ozon_order_number}` : ''}
                  </Link>
                </dd>
              </>
            )}
          </dl>
          <h3>История</h3>
          <ul className="timeline">
            {u.events.map((e) => (
              <li key={e.id}>
                <strong>{UNIT_EVENT[e.type] ?? e.type}</strong>
                {e.to_status && <span className="muted"> → {UNIT_STATUS[e.to_status] ?? e.to_status}</span>}
                {e.reference?.type === 'order' && (
                  <>
                    {' '}
                    <Link className="small" to={'/orders/' + e.reference.id}>
                      заказ VITALO
                    </Link>
                  </>
                )}
                {e.reference?.type === 'marketplace_order' && (
                  <>
                    {' '}
                    <Link className="small" to={'/yandex-orders/' + e.reference.id}>
                      заказ Яндекса
                    </Link>
                  </>
                )}
                <div className="muted small">
                  {dateTime(e.created_at)} · {e.staff_name ?? 'система'}
                  {e.note ? ` · ${e.note}` : ''}
                </div>
              </li>
            ))}
          </ul>
          <UnitActions unit={u} onPick={setAction} />
          {action && <UnitActionModal unit={u} action={action} onClose={() => setAction(null)} />}
          <div className="modal-actions">
            {u.status !== 'VOIDED' && (
              <PrintLink scope={{ unit_ids: [u.id] }}>Напечатать этикетку</PrintLink>
            )}
            <button className="btn btn-ghost" onClick={onClose}>
              Закрыть
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ====================================================================== Сверка

interface ReconcileRow {
  product_id: string;
  sku: string;
  name_ru: string;
  units_in_stock: number;
  units_reserved_yandex: number;
  units_reserved_vitalo: number;
  actual_qty: number;
  reserved_qty: number;
  reserved_vitalo: number;
  difference: number;
  sold_by_orders: number;
  explained: boolean;
  state: 'ok' | 'legacy_orders' | 'unexplained';
}

export function Reconcile() {
  const q = useQuery({ queryKey: ['units-reconcile'], queryFn: () => api<{ hint: string; items: ReconcileRow[] }>('/staff/units/reconcile') });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const bad = q.data.items.filter((r) => !r.explained).length;
  return (
    <>
      <div className="alert alert-info">{q.data.hint}</div>
      {bad > 0 && <div className="alert alert-error">Не объясняется: {bad} — проверьте эти товары (красные строки).</div>}
      {!q.data.items.length ? (
        <p className="muted">Товаров с учётом по единицам пока нет: они появятся после завершения начального остатка.</p>
      ) : (
        <section className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>Товар</th>
                <th className="num">Банок на полке</th>
                <th className="num">резерв Яндекса</th>
                <th className="num">резерв Mini App</th>
                <th className="num">Остаток</th>
                <th className="num">Резерв по количеству</th>
                <th className="num">Разница</th>
                <th className="num">Старые заказы без банок</th>
                <th>Итог</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((r) => (
                <tr key={r.product_id} className={r.explained ? '' : 'row-bad'}>
                  <td>
                    <Link to={`/products/${r.product_id}`}>{r.sku}</Link>
                    <div className="muted small">{r.name_ru}</div>
                  </td>
                  <td className="num">{r.units_in_stock}</td>
                  <td className="num">{r.units_reserved_yandex}</td>
                  <td className="num">{r.units_reserved_vitalo}</td>
                  <td className="num">{r.actual_qty}</td>
                  <td className="num">{r.reserved_vitalo}</td>
                  <td className="num strong">{r.difference}</td>
                  <td className="num">{r.sold_by_orders}</td>
                  <td>
                    {r.state === 'ok' ? (
                      <Badge tone="ok">сходится</Badge>
                    ) : r.state === 'legacy_orders' ? (
                      <Badge tone="info">старые заказы без банок</Badge>
                    ) : (
                      <Badge tone="bad">не объясняется</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <p className="muted small">То же в терминале: npm run reconcile:units (только чтение).</p>
    </>
  );
}

// ====================================================================== Stage 2C: actions on a unit

type UnitAction = 'missing' | 'found' | 'write-off' | 'accept' | 'return-write-off' | 'correct';

const ACTION_INFO: Record<UnitAction, { title: string; button: string; reasons: readonly string[]; note: string }> = {
  missing: { title: 'Отметить потерянной', button: 'Отметить «Потеряна»', reasons: REASONS.missing, note: 'Банка уйдёт из остатка. Если найдётся — «Банка найдена».' },
  found: { title: 'Банка найдена', button: 'Вернуть на склад', reasons: REASONS.found, note: 'Банка снова будет «На складе», остаток +1.' },
  'write-off': { title: 'Списать банку', button: 'Списать', reasons: REASONS.writeoff, note: 'Только администратор. Банка не удаляется: статус «Списана», история сохраняется.' },
  accept: { title: 'Возврат: вернуть на склад', button: 'Вернуть на склад', reasons: REASONS.accept, note: 'Проверьте срок годности и целостность банки.' },
  'return-write-off': { title: 'Возврат: списать', button: 'Списать', reasons: REASONS.returnWriteoff, note: 'Банка из возврата списывается.' },
  correct: { title: 'Корректировка (явная ошибка)', button: 'Сохранить корректировку', reasons: REASONS.correct, note: 'Только администратор. Всё пишется в историю банки и журнал аудита.' },
};

/** Buttons for the actions this employee may do with this unit in its status. */
function UnitActions({ unit, onPick }: { unit: UnitCard; onPick: (a: UnitAction) => void }) {
  const { can } = useSession();
  const list: UnitAction[] = [];
  if (unit.status === 'IN_STOCK' && can('units.missing')) list.push('missing');
  if (unit.status === 'MISSING' && can('units.missing')) list.push('found');
  if (unit.status === 'RETURNED' && can('units.return_decision')) list.push('accept', 'return-write-off');
  if (['IN_STOCK', 'MISSING'].includes(unit.status) && can('units.writeoff')) list.push('write-off');
  if (unit.status !== 'VOIDED' && can('units.correct')) list.push('correct');
  if (!list.length) return null;
  return (
    <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
      {list.map((a) => (
        <button key={a} className="btn btn-ghost" onClick={() => onPick(a)}>
          {ACTION_INFO[a].title}
        </button>
      ))}
    </div>
  );
}

const CORRECT_STATUSES = ['IN_STOCK', 'MISSING', 'WRITTEN_OFF'];

/** «31.12.2027» -> «2027-12-31» (anything else stays as typed, the server answers 400). */
const isoOf = (ru: string) => (/^\d{2}\.\d{2}\.\d{4}$/.test(ru) ? `${ru.slice(6)}-${ru.slice(3, 5)}-${ru.slice(0, 2)}` : ru);

function UnitActionModal({ unit, action, onClose }: { unit: UnitCard; action: UnitAction; onClose: () => void }) {
  const client = useQueryClient();
  const info = ACTION_INFO[action];
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  const [expiry, setExpiry] = useState(ruDate(unit.expiry_date));
  const [status, setStatus] = useState('');
  const m = useMutation({
    mutationFn: () => {
      const path = action === 'accept' || action === 'return-write-off' ? 'return-decision' : action;
      const body =
        action === 'accept'
          ? { decision: 'ACCEPT', reason, checked }
          : action === 'return-write-off'
            ? { decision: 'WRITE_OFF', reason }
            : action === 'correct'
              ? { reason, ...(isoOf(expiry) !== unit.expiry_date && { expiry_date: isoOf(expiry) }), ...(status && { status }) }
              : { reason };
      return api(`/staff/units/${unit.id}/${path}`, { method: 'POST', body });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['unit', unit.id] });
      void client.invalidateQueries({ queryKey: ['units'] });
      void client.invalidateQueries({ queryKey: ['units-returns'] });
      void client.invalidateQueries({ queryKey: ['units-reconcile'] });
      onClose();
    },
  });
  const ready = reason.length >= 3 && (action !== 'accept' || checked) && (action !== 'correct' || status !== '' || isoOf(expiry) !== unit.expiry_date);
  return (
    <Modal title={`${info.title}: ${unit.physical_id}`} onClose={onClose}>
      <p className="muted">{info.note}</p>
      {action === 'correct' && (
        <div className="form-grid">
          <Field label="Срок годности" hint="ДД.ММ.ГГГГ">
            <input value={expiry} onChange={(e) => setExpiry(maskDate(e.target.value))} inputMode="numeric" />
          </Field>
          <Field label="Статус">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">не менять ({UNIT_STATUS[unit.status] ?? unit.status})</option>
              {CORRECT_STATUSES.filter((x) => x !== unit.status).map((x) => (
                <option key={x} value={x}>
                  {UNIT_STATUS[x]}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      <ReasonPicker options={info.reasons} onChange={setReason} />
      {action === 'accept' && (
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> Срок годности ({ruDate(unit.expiry_date)}) и целостность банки проверены
        </label>
      )}
      <ErrorBox error={m.error} />
      <div className="modal-actions">
        <button className="btn" disabled={!ready || m.isPending} onClick={() => m.mutate()}>
          {info.button}
        </button>
        <button className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
      </div>
    </Modal>
  );
}

interface PendingReturn {
  id: string;
  physical_id: string;
  product: { sku: string; name_ru: string };
  expiry_date: string;
  expired: boolean;
  order: { id: string; external_number: string; cancel_reason: string | null } | null;
  vitalo_order?: { id: string; order_number: string } | null;
}

/** «Возвраты на проверке»: returned units waiting for the warehouse decision. */
function PendingReturns({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ['units-returns'], queryFn: () => api<PendingReturn[]>('/staff/units/returns/pending') });
  if (!q.data?.length) return null;
  return (
    <section className="card">
      <h2>Возвраты на проверке: {q.data.length}</h2>
      <p className="muted small">Откройте банку и примите решение: вернуть на склад (срок и целостность проверены) или списать.</p>
      <table className="table table-hover">
        <tbody>
          {q.data.map((r) => (
            <tr key={r.id} onClick={() => onOpen(r.id)} style={{ cursor: 'pointer' }}>
              <td>
                <span className="id-chip">{r.physical_id}</span>
              </td>
              <td>
                <strong>{r.product.sku}</strong>
                <div className="muted small">{r.product.name_ru}</div>
              </td>
              <td>
                {ruDate(r.expiry_date)}
                {r.expired && <div className="small text-warn">срок истёк — только списать</div>}
              </td>
              <td className="small">
                {r.order ? (
                  <>
                    Яндекс № {r.order.external_number}
                    {r.order.cancel_reason && <div className="muted">{r.order.cancel_reason}</div>}
                  </>
                ) : r.vitalo_order ? (
                  <>Заказ VITALO {r.vitalo_order.order_number}</>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
