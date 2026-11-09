import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BackIcon } from '../components/Icons';
import { Badge, ErrorBox, Field, Loading, PageHead } from '../components/ui';
import { api, errorText, qs } from '../lib/api';
import { useSession } from '../lib/auth';
import { dateTime, ORDER_STATUS, ruDate } from '../lib/format';

/** D-60: «Посылки из США» — what customers paid for and is not ordered on iHerb yet, and the parcels on their way. */

type BatchStage = 'ordered' | 'shipped' | 'arrived_uz' | 'received';

export const BATCH_STAGE: Record<BatchStage, [string, 'neutral' | 'ok' | 'warn' | 'bad' | 'info']> = {
  ordered: ['Заказана в США', 'neutral'],
  shipped: ['Отправлена из США', 'info'],
  arrived_uz: ['Прибыла в Узбекистан', 'info'],
  received: ['Принята на склад', 'ok'],
};
/** The next manual stage of a parcel; «received» comes by itself after the receiving. */
const NEXT_STAGE: Partial<Record<BatchStage, 'shipped' | 'arrived_uz'>> = { ordered: 'shipped', shipped: 'arrived_uz' };

interface WaitingLine {
  item_id: string;
  order_id: string;
  order_number: string;
  paid_at: string | null;
  expected_to: string | null;
  product_id: string;
  sku: string;
  name_ru: string;
  iherb_url: string | null;
  qty: number;
}

interface BatchSummary {
  id: string;
  number: number;
  stage: BatchStage;
  note: string | null;
  ordered_at: string | null;
  shipped_at: string | null;
  arrived_uz_at: string | null;
  received_at: string | null;
  purchase: { id: string; purchase_date: string; status: string } | null;
  orders: number;
  jars: number;
  jars_arrived: number;
}

interface BatchDetail extends BatchSummary {
  items: {
    item_id: string;
    order_id: string;
    order_number: string;
    order_status: string;
    expected_from: string | null;
    expected_to: string | null;
    sku: string;
    name_ru: string;
    qty: number;
    arrived_at: string | null;
  }[];
}

interface Settings {
  days_min: number;
  days_max: number;
  guarantee_days: number;
}

interface PurchaseOption {
  id: string;
  purchase_date: string;
  status: string;
  supplier: { name: string } | null;
  ozon_account: { name: string } | null;
  ozon_order_number: string | null;
  comment: string | null;
}

const purchaseLabel = (p: PurchaseOption) =>
  [ruDate(p.purchase_date), p.supplier?.name ?? p.ozon_account?.name, p.ozon_order_number, p.comment].filter(Boolean).join(' · ');

const overdue = (iso: string | null) => !!iso && iso < new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);

function useExpectedPurchases() {
  return useQuery({
    queryKey: ['purchases', 'expected'],
    queryFn: () => api<{ items: PurchaseOption[] }>(`/staff/purchases${qs({ status: 'EXPECTED' })}`),
  });
}

function PurchaseSelect({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const q = useExpectedPurchases();
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">— не выбрана —</option>
      {q.data?.items.map((p) => (
        <option key={p.id} value={p.id}>
          {purchaseLabel(p)}
        </option>
      ))}
    </select>
  );
}

export function CrossBorder() {
  const { can } = useSession();
  const manage = can('cross_border.manage');
  const client = useQueryClient();
  const waiting = useQuery({ queryKey: ['cross-border', 'waiting'], queryFn: () => api<WaitingLine[]>('/staff/cross-border/waiting') });
  const batches = useQuery({ queryKey: ['cross-border', 'batches'], queryFn: () => api<BatchSummary[]>('/staff/cross-border/batches') });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [purchase, setPurchase] = useState('');
  const refresh = () => void client.invalidateQueries({ queryKey: ['cross-border'] });

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; number: number }>('/staff/cross-border/batches', {
        method: 'POST',
        body: { item_ids: [...picked], note: note.trim() || undefined, purchase_id: purchase || undefined },
      }),
    onSuccess: () => {
      setPicked(new Set());
      setNote('');
      setPurchase('');
      refresh();
    },
  });
  const attach = useMutation({
    mutationFn: (itemId: string) => api(`/staff/cross-border/items/${itemId}/attach`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const lines = waiting.data ?? [];
  const allPicked = lines.length > 0 && lines.every((l) => picked.has(l.item_id));

  return (
    <>
      <PageHead title="Посылки из США" />
      <p className="muted">
        Здесь товары «Под заказ из США»: покупатель оплатил, а на складе в Ташкенте их не было. Закажите их на iHerb, отметьте строки и нажмите
        «Создать посылку» — покупатели получат сообщение «Заказан в США». Дальше двигайте этап посылки; когда посылку примут на складе по
        выбранной закупке, банки сами закрепятся за заказами, и заказы можно собирать.
      </p>

      <section className="card flush">
        <div className="card-head">
          <h2>Ждут заказа в США</h2>
          {lines.length > 0 && <Badge tone="warn">{lines.length}</Badge>}
        </div>
        {waiting.isPending ? (
          <Loading />
        ) : waiting.isError ? (
          <ErrorBox error={waiting.error} onRetry={() => void waiting.refetch()} />
        ) : !lines.length ? (
          <p className="muted cb-empty">Новых оплаченных заказов «из США» нет.</p>
        ) : (
          <>
            <table className="table table-hover">
              <thead>
                <tr>
                  {manage && (
                    <th>
                      <input type="checkbox" aria-label="Отметить все" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(lines.map((l) => l.item_id)))} />
                    </th>
                  )}
                  <th>Товар</th>
                  <th className="num">Банок</th>
                  <th>Заказ</th>
                  <th>Оплачен</th>
                  <th>Обещали до</th>
                  {manage && <th />}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.item_id} className={overdue(l.expected_to) ? 'row-warn' : ''}>
                    {manage && (
                      <td>
                        <input type="checkbox" aria-label={`Отметить ${l.sku}`} checked={picked.has(l.item_id)} onChange={() => toggle(l.item_id)} />
                      </td>
                    )}
                    <td>
                      <strong>{l.name_ru}</strong>
                      <div className="muted small">
                        {l.sku}
                        {l.iherb_url && (
                          <>
                            {' · '}
                            <a href={l.iherb_url} target="_blank" rel="noreferrer">
                              открыть на iHerb
                            </a>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="num">{l.qty}</td>
                    <td>
                      <Link to={`/orders/${l.order_id}`}>{l.order_number}</Link>
                    </td>
                    <td>{dateTime(l.paid_at)}</td>
                    <td>{overdue(l.expected_to) ? <Badge tone="bad">{ruDate(l.expected_to)}</Badge> : ruDate(l.expected_to)}</td>
                    {manage && (
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={attach.isPending}
                          title="Если банки уже есть на складе в Ташкенте — закрепить их за заказом, не дожидаясь посылки"
                          onClick={() => window.confirm(`Отдать ${l.qty} шт. «${l.name_ru}» со склада заказу ${l.order_number}?`) && attach.mutate(l.item_id)}
                        >
                          Отдать со склада
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {attach.isError && <p className="text-bad cb-pad">{errorText(attach.error)}</p>}
            {manage && (
              <div className="cb-create">
                <div className="form-grid">
                  <Field label="Закупка, по которой примем посылку" hint="Можно выбрать позже, в посылке">
                    <PurchaseSelect value={purchase} onChange={setPurchase} />
                  </Field>
                  <Field label="Заметка (видят только сотрудники)">
                    <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Например: заказ iHerb №…" />
                  </Field>
                </div>
                <button type="button" className="btn" disabled={!picked.size || create.isPending} onClick={() => create.mutate()}>
                  {create.isPending ? 'Создаю…' : `Создать посылку (${picked.size})`}
                </button>
                {create.isError && <p className="text-bad">{errorText(create.error)}</p>}
              </div>
            )}
          </>
        )}
      </section>

      <section className="card flush">
        <div className="card-head">
          <h2>Посылки</h2>
        </div>
        {batches.isPending ? (
          <Loading />
        ) : batches.isError ? (
          <ErrorBox error={batches.error} onRetry={() => void batches.refetch()} />
        ) : !batches.data.length ? (
          <p className="muted cb-empty">Посылок пока нет.</p>
        ) : (
          <table className="table table-hover">
            <thead>
              <tr>
                <th>Посылка</th>
                <th>Этап</th>
                <th className="num">Заказов</th>
                <th className="num">Банок на складе</th>
                <th>Закупка</th>
                <th>Создана</th>
              </tr>
            </thead>
            <tbody>
              {batches.data.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link to={`/cross-border/${b.id}`} className="strong">
                      № {b.number}
                    </Link>
                    {b.note && <div className="muted small">{b.note}</div>}
                  </td>
                  <td>
                    <Badge tone={BATCH_STAGE[b.stage][1]}>{BATCH_STAGE[b.stage][0]}</Badge>
                  </td>
                  <td className="num">{b.orders}</td>
                  <td className="num">
                    {b.jars_arrived} из {b.jars}
                  </td>
                  <td>{b.purchase ? <Link to={`/purchases/${b.purchase.id}`}>{ruDate(b.purchase.purchase_date)}</Link> : <span className="muted">не выбрана</span>}</td>
                  <td>{dateTime(b.ordered_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <CrossBorderSettingsCard />
    </>
  );
}

/** Сроки «из США» and the money-back guarantee: everyone sees them, only the admin changes them. */
function CrossBorderSettingsCard() {
  const { can } = useSession();
  const edit = can('settings.manage');
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['cross-border', 'settings'], queryFn: () => api<Settings>('/staff/cross-border/settings') });
  const [form, setForm] = useState<Record<keyof Settings, string> | null>(null);
  const save = useMutation({
    mutationFn: (body: Settings) => api<Settings>('/staff/cross-border/settings', { method: 'PUT', body }),
    onSuccess: (s) => {
      client.setQueryData(['cross-border', 'settings'], s);
      setForm(null);
    },
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const f = form ?? { days_min: String(s.days_min), days_max: String(s.days_max), guarantee_days: String(s.guarantee_days) };
  const set = (k: keyof Settings, v: string) => setForm({ ...f, [k]: v });
  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate({ days_min: Number(f.days_min), days_max: Number(f.days_max), guarantee_days: Number(f.guarantee_days) });
  }
  return (
    <section className="card narrow">
      <h2>Сроки и гарантия</h2>
      <p className="muted">
        Покупатель видит «Под заказ из США • {s.days_min}–{s.days_max} дней»; ожидаемая дата считается от оплаты. Если через {s.guarantee_days} дней после
        оплаты товара нет на складе, покупатель может сам отменить заказ — менеджеру придёт задача вернуть деньги.
      </p>
      {edit && (
        <form onSubmit={submit}>
          <div className="form-grid">
            <Field label="Срок: с, дней">
              <input type="number" min={1} max={90} value={f.days_min} onChange={(e) => set('days_min', e.target.value)} />
            </Field>
            <Field label="Срок: по, дней">
              <input type="number" min={1} max={120} value={f.days_max} onChange={(e) => set('days_max', e.target.value)} />
            </Field>
            <Field label="Гарантия возврата, дней" hint="Не меньше срока «по»">
              <input type="number" min={1} max={180} value={f.guarantee_days} onChange={(e) => set('guarantee_days', e.target.value)} />
            </Field>
          </div>
          <button type="submit" className="btn" disabled={!form || save.isPending}>
            {save.isPending ? 'Сохраняю…' : 'Сохранить'}
          </button>
          {save.isError && <p className="text-bad">{errorText(save.error)}</p>}
        </form>
      )}
    </section>
  );
}

export function CrossBorderBatch() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const manage = can('cross_border.manage');
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['cross-border', 'batch', id], queryFn: () => api<BatchDetail>(`/staff/cross-border/batches/${id}`) });
  const refresh = () => void client.invalidateQueries({ queryKey: ['cross-border'] });
  const stage = useMutation({
    mutationFn: (to: 'shipped' | 'arrived_uz') => api(`/staff/cross-border/batches/${id}/stage`, { method: 'POST', body: { stage: to } }),
    onSuccess: refresh,
  });
  const purchase = useMutation({
    mutationFn: (pid: string) => api(`/staff/cross-border/batches/${id}/purchase`, { method: 'PUT', body: { purchase_id: pid || null } }),
    onSuccess: refresh,
  });
  const attach = useMutation({
    mutationFn: (itemId: string) => api(`/staff/cross-border/items/${itemId}/attach`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const move = useMutation({
    mutationFn: () => api<{ moved: number }>('/staff/cross-border/move-date', { method: 'POST', body: { batch_id: id, expected_to: date, reason: reason.trim() } }),
    onSuccess: () => {
      setDate('');
      setReason('');
      refresh();
    },
  });

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const b = q.data;
  const next = NEXT_STAGE[b.stage];
  const steps: [BatchStage, string | null][] = [
    ['ordered', b.ordered_at],
    ['shipped', b.shipped_at],
    ['arrived_uz', b.arrived_uz_at],
    ['received', b.received_at],
  ];

  return (
    <>
      <PageHead
        title={
          <>
            <Link to="/cross-border" className="icon-btn" aria-label="Назад">
              <BackIcon />
            </Link>{' '}
            Посылка № {b.number}
          </>
        }
      >
        <Badge tone={BATCH_STAGE[b.stage][1]}>{BATCH_STAGE[b.stage][0]}</Badge>
      </PageHead>
      {b.note && <p className="muted">{b.note}</p>}

      <div className="grid-2">
        <section className="card">
          <h2>Этапы</h2>
          <ol className="cb-steps">
            {steps.map(([s, at]) => (
              <li key={s} className={at ? 'is-done' : ''}>
                <span>{BATCH_STAGE[s][0]}</span>
                <span className="muted small">{at ? dateTime(at) : '—'}</span>
              </li>
            ))}
          </ol>
          {manage && next && (
            <button
              type="button"
              className="btn"
              disabled={stage.isPending}
              onClick={() => window.confirm(`Отметить «${BATCH_STAGE[next][0]}»? Покупатели ${b.orders} заказов получат сообщение.`) && stage.mutate(next)}
            >
              {BATCH_STAGE[next][0]}
            </button>
          )}
          {b.stage === 'arrived_uz' && <p className="muted small">«Принята на склад» отметится само после приёмки по выбранной закупке.</p>}
          {stage.isError && <p className="text-bad">{errorText(stage.error)}</p>}
          <Field label="Закупка, по которой примем посылку">
            <PurchaseSelect value={b.purchase?.id ?? ''} disabled={!manage || purchase.isPending || b.stage === 'received'} onChange={(pid) => purchase.mutate(pid)} />
          </Field>
          {purchase.isError && <p className="text-bad">{errorText(purchase.error)}</p>}
        </section>

        {manage && b.stage !== 'received' && (
          <section className="card">
            <h2>Сдвинуть дату</h2>
            <p className="muted small">Новая дата и причина придут покупателям всех заказов этой посылки и будут видны в их заказе.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                move.mutate();
              }}
            >
              <Field label="Ожидаемая доставка — до">
                <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Причина (её прочитает покупатель)">
                <input value={reason} required minLength={3} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Например: задержка на таможне" />
              </Field>
              <button type="submit" className="btn" disabled={move.isPending || !date || reason.trim().length < 3}>
                {move.isPending ? 'Сохраняю…' : 'Сдвинуть и сообщить'}
              </button>
              {move.isSuccess && <p className="text-ok">Сообщили покупателям: {move.data.moved}</p>}
              {move.isError && <p className="text-bad">{errorText(move.error)}</p>}
            </form>
          </section>
        )}
      </div>

      <section className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>Заказ</th>
              <th>Товар</th>
              <th className="num">Банок</th>
              <th>Обещали</th>
              <th>Банки</th>
            </tr>
          </thead>
          <tbody>
            {b.items.map((i) => (
              <tr key={i.item_id} className={!i.arrived_at && overdue(i.expected_to) ? 'row-warn' : ''}>
                <td>
                  <Link to={`/orders/${i.order_id}`}>{i.order_number}</Link>
                  <div className="muted small">{ORDER_STATUS[i.order_status] ?? i.order_status}</div>
                </td>
                <td>
                  <strong>{i.name_ru}</strong>
                  <div className="muted small">{i.sku}</div>
                </td>
                <td className="num">{i.qty}</td>
                <td>
                  {i.expected_from && i.expected_from !== i.expected_to ? `${ruDate(i.expected_from)} – ` : ''}
                  {ruDate(i.expected_to)}
                </td>
                <td>
                  {i.arrived_at ? (
                    <Badge tone="ok">На складе {dateTime(i.arrived_at)}</Badge>
                  ) : manage && i.order_status === 'paid' ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={attach.isPending}
                      onClick={() => window.confirm(`Отдать ${i.qty} шт. «${i.name_ru}» со склада заказу ${i.order_number}?`) && attach.mutate(i.item_id)}
                    >
                      Отдать со склада
                    </button>
                  ) : (
                    <span className="muted">ждём</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {attach.isError && <p className="text-bad cb-pad">{errorText(attach.error)}</p>}
      </section>
    </>
  );
}
