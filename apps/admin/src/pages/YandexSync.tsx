import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ReasonPicker } from '../components/Reason';
import { Badge, ErrorBox, Loading, Modal, PageHead, Help } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime } from '../lib/format';

/**
 * Stage 2D «Синхронизация Яндекса» (admin only): the mode, the last runs with their counters, «Проверить сейчас»
 * and «Требует внимания» with «Закрыть как неактуальный». Read only towards Yandex: nothing here writes to it.
 */

interface Run {
  id: string;
  trigger: 'schedule' | 'manual' | 'webhook';
  mode: 'DRY_RUN' | 'LIVE';
  started_at: string;
  finished_at: string | null;
  found: number;
  created: number;
  updated: number;
  attention: number;
  errors: number;
  error: string | null;
  details?: { items: { number: string | null; status?: string; action: string; reason?: string }[]; raw?: unknown[] } | null;
}

interface Attention {
  id: string;
  external_number: string;
  status_ru: string;
  kind_ru: string;
  attention_reason: string | null;
  attention_at: string | null;
  order_id: string | null;
  last_error: string | null;
}

interface SyncStatus {
  config: {
    tokenSet: boolean;
    businessId: number;
    campaignIds: number[];
    enabled: boolean;
    dryRun: boolean;
    intervalMinutes: number;
    days: number;
    firstDays: number;
    webhookEnabled: boolean;
  };
  running: boolean;
  rate_limit: { limit: number | null; remaining: number | null; until: string | null; at?: string; calls_today?: number } | null;
  runs: Run[];
  /** runs where something was created, updated, raised or failed (the latest 20) */
  busy_runs?: Run[];
  attention: Attention[];
}

const isEmptyRun = (r: Run) => !r.created && !r.updated && !r.attention && !r.errors && !r.error;

const TRIGGER: Record<Run['trigger'], string> = { schedule: 'по расписанию', manual: 'вручную', webhook: 'уведомление' };
const ACTION: Record<string, string> = {
  would_create: 'создал бы заказ',
  would_create_without_units: 'создал бы без банок (не хватает остатка)',
  would_attention: 'в «Требует внимания»',
  would_cancel: 'отменил бы наш заказ',
  would_return: 'оформил бы возврат',
  would_update_status: 'обновил бы статус Яндекса',
  created: 'создан заказ',
  created_without_units: 'создан без банок (не хватает остатка)',
  attention: 'в «Требует внимания»',
  cancelled: 'наш заказ отменён',
  returned: 'оформлен возврат',
  status_updated: 'обновлён статус Яндекса',
  unchanged: 'без изменений',
  skip: 'пропущен',
  error: 'ошибка',
};
const CLOSE_REASONS = ['Старый заказ, уже обработан вручную', 'Заказ отменён до нашего учёта', 'Тестовый или ошибочный заказ'];

export function YandexSync() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['yandex-sync'], queryFn: () => api<SyncStatus>('/staff/yandex-sync'), refetchInterval: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [closing, setClosing] = useState<Attention | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [closingMany, setClosingMany] = useState(false);
  const [allRuns, setAllRuns] = useState(false);
  const run = useMutation({
    mutationFn: () => api<Run | { skipped: string }>('/staff/yandex-sync/run', { method: 'POST' }),
    onSettled: () => void client.invalidateQueries({ queryKey: ['yandex-sync'] }),
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const { config: c, runs, attention } = q.data;
  const last = runs[0];
  const lastEmpty = runs.find(isEmptyRun);
  const shownRuns = allRuns || !q.data.busy_runs ? runs : q.data.busy_runs;
  // only entries without our order (no units can be held) are closed in a batch
  const selectable = attention.filter((a) => !a.order_id);
  const chosen = selectable.filter((a) => selected.has(a.id));
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;
  const toggle = (id: string) => setSelected((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  return (
    <>
      <PageHead title="Синхронизация Яндекса">
        <button className="btn" disabled={run.isPending || q.data.running} onClick={() => run.mutate()}>
          {run.isPending ? 'Проверяю…' : 'Проверить сейчас'}
        </button>
      </PageHead>
      {run.data && 'skipped' in run.data && <div className="alert alert-info">{run.data.skipped}</div>}
      {run.data && !('skipped' in run.data) && (
        <div className={`alert ${run.data.error ? 'alert-error' : 'alert-ok'}`}>
          {run.data.error ?? `Готово: найдено ${run.data.found}, ${run.data.mode === 'DRY_RUN' ? 'было бы создано' : 'создано'} ${run.data.created}, обновлено ${run.data.updated}, требует внимания ${run.data.attention}, ошибок ${run.data.errors}.`}
        </div>
      )}
      <ErrorBox error={run.error} />

      <section className="card">
        <dl className="props">
          <dt>Режим</dt>
          <dd>
            {c.dryRun ? <Badge tone="warn">DRY_RUN — только журнал, заказы не создаются</Badge> : <Badge tone="ok">Рабочий — заказы создаются</Badge>}
          </dd>
          <dt>Опрос</dt>
          <dd>{c.enabled ? `включён, каждые ${c.intervalMinutes} мин, за ${c.days} дн. (первый раз ${c.firstDays})` : 'выключен (YANDEX_SYNC_ENABLED) — работает только «Проверить сейчас»'}</dd>
          <dt>Токен</dt>
          <dd>{c.tokenSet ? 'задан' : <span className="text-warn">не задан: подключение ещё не настроено (ключ YANDEX_API_KEY в настройках сервера)</span>}</dd>
          <dt>Кабинет / кампании</dt>
          <dd>
            {c.businessId} / {c.campaignIds.join(', ')}
          </dd>
          <dt>Уведомления Яндекса</dt>
          <dd>{c.webhookEnabled ? 'включены' : 'выключены (включаются после переезда на сервер)'}</dd>
          {/* аудит 4.7: our own count for today; Yandex's «осталось» is for one kind of request, as of the last answer */}
          <dt>Запросов к Яндексу сегодня</dt>
          <dd>
            {q.data.rate_limit?.calls_today ?? 0}
            <div className="muted small">считает наш сервер; после перезапуска сервера счёт начинается заново</div>
          </dd>
          {q.data.rate_limit?.remaining !== null && q.data.rate_limit?.remaining !== undefined && (
            <>
              <dt>Лимит Яндекса</dt>
              <dd>
                осталось {q.data.rate_limit.remaining} из {q.data.rate_limit.limit ?? '—'}
                <div className="muted small">
                  по последнему ответу Яндекса{q.data.rate_limit.at ? ` (${dateTime(q.data.rate_limit.at)})` : ''}; лимит у каждого вида запросов свой
                  {q.data.rate_limit.until && !Number.isNaN(Date.parse(q.data.rate_limit.until)) ? `, обновится ${dateTime(q.data.rate_limit.until)}` : ''}
                </div>
              </dd>
            </>
          )}
          <dt>Последний запуск</dt>
          <dd>
            {last ? (
              <>
                {dateTime(last.started_at)}, {TRIGGER[last.trigger]}, {last.mode}
                {last.error ? <div className="text-warn">{last.error}</div> : null}
              </>
            ) : (
              'ещё не было'
            )}
          </dd>
        </dl>
      </section>

      <section className="card flush">
        <div className="section-head pad">
          <h2>Требует внимания: {attention.length}</h2>
          {selectable.length > 0 && (
            <span>
              <span className="muted small">Выбрано: {chosen.length}</span>{' '}
              <button className="btn btn-sm" disabled={!chosen.length} onClick={() => setClosingMany(true)}>
                Закрыть выбранные как неактуальные
              </button>
            </span>
          )}
        </div>
        {!attention.length ? (
          <p className="muted pad">Нет заказов, требующих внимания.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Выбрать все"
                    title="Выбрать все (кроме заказов, уже созданных у нас)"
                    checked={allChosen}
                    disabled={!selectable.length}
                    onChange={() => setSelected(allChosen ? new Set() : new Set(selectable.slice(0, 100).map((a) => a.id)))}
                  />
                </th>
                <th>№ Яндекса</th>
                <th>Статус Яндекса</th>
                <th>Что не так</th>
                <th>С</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {attention.map((a) => (
                <tr key={a.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Выбрать ${a.external_number}`}
                      checked={selected.has(a.id)}
                      disabled={!!a.order_id}
                      title={a.order_id ? 'Заказ уже создан у нас (может держать банки) — решайте в его карточке' : undefined}
                      onChange={() => toggle(a.id)}
                    />
                  </td>
                  <td>
                    {a.order_id ? <Link to={`/yandex-orders/${a.order_id}`}>{a.external_number}</Link> : a.external_number}
                  </td>
                  <td className="small">{a.status_ru}</td>
                  <td>
                    <strong>{a.kind_ru}</strong>
                    <div className="muted small">{a.attention_reason}</div>
                    {a.last_error && <div className="small text-warn">{a.last_error}</div>}
                  </td>
                  <td className="small">{a.attention_at ? dateTime(a.attention_at) : '—'}</td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => setRaw(a.id)}>
                        Ответ Яндекса
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={() => setClosing(a)} title="Закрыть как неактуальный">
                        Закрыть…
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card flush">
        <div className="section-head pad">
          <h2>Журнал запусков</h2>
          <label className="check">
            <input type="checkbox" checked={allRuns} onChange={(e) => setAllRuns(e.target.checked)} />
            Показать все
          </label>
        </div>
        {!allRuns && lastEmpty && (
          <p className="muted small pad">
            Последний запуск без изменений: {dateTime(lastEmpty.started_at)}, {TRIGGER[lastEmpty.trigger]}. Такие запуски скрыты — включите «Показать все».
          </p>
        )}
        {shownRuns.length === 0 ? (
          <p className="muted pad">Запусков с изменениями пока не было.</p>
        ) : (
        <table className="table table-hover">
          <thead>
            <tr>
              <th>Начало</th>
              <th>Как</th>
              <th>Режим</th>
              <th className="num">Найдено</th>
              <th className="num">Создано</th>
              <th className="num">Обновлено</th>
              <th className="num">Внимание</th>
              <th className="num">Ошибок</th>
            </tr>
          </thead>
          <tbody>
            {shownRuns.map((r) => (
              <tr key={r.id} onClick={() => setOpen(r.id)} style={{ cursor: 'pointer' }} className={r.error ? 'row-bad' : ''}>
                <td>
                  {dateTime(r.started_at)}
                  {r.error && <div className="small text-warn">{r.error}</div>}
                </td>
                <td className="small">{TRIGGER[r.trigger]}</td>
                <td className="small">{r.mode}</td>
                <td className="num">{r.found}</td>
                <td className="num">{r.created}</td>
                <td className="num">{r.updated}</td>
                <td className="num">{r.attention}</td>
                <td className="num">{r.errors}</td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </section>

      {open && <RunModal id={open} onClose={() => setOpen(null)} />}
      {raw && <RawModal id={raw} onClose={() => setRaw(null)} />}
      {closing && <CloseModal row={closing} onClose={() => setClosing(null)} />}
      {closingMany && (
        <CloseManyModal
          rows={chosen}
          onClose={() => setClosingMany(false)}
          onDone={() => {
            setSelected(new Set());
            setClosingMany(false);
          }}
        />
      )}
    </>
  );
}

function RunModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['yandex-sync-run', id], queryFn: () => api<Run>(`/staff/yandex-sync/runs/${id}`) });
  const [showRaw, setShowRaw] = useState(false);
  const r = q.data;
  return (
    <Modal title={r ? `Запуск ${dateTime(r.started_at)} · ${r.mode}` : 'Запуск'} onClose={onClose} wide>
      {q.isPending ? (
        <Loading />
      ) : !r ? (
        <ErrorBox error={q.error} />
      ) : (
        <>
          {r.mode === 'DRY_RUN' && <div className="alert alert-info">Режим DRY_RUN: ничего не создано, ниже — что было бы сделано.</div>}
          {r.error && <div className="alert alert-error">{r.error}</div>}
          {!r.details?.items.length ? (
            <p className="muted">Заказов не было.</p>
          ) : (
            <table className="table">
              <tbody>
                {r.details.items.map((d, i) => (
                  <tr key={i}>
                    <td>{d.number ?? '—'}</td>
                    <td className="small">{d.status ?? ''}</td>
                    <td>
                      <strong>{ACTION[d.action] ?? d.action}</strong>
                      {d.reason && <div className="muted small">{d.reason}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!!r.details?.raw?.length && (
            <>
              <button className="btn btn-sm btn-ghost" onClick={() => setShowRaw(!showRaw)}>
                {showRaw ? 'Скрыть ответы Яндекса' : `Ответы Яндекса (${r.details.raw.length})`}
              </button>
              {showRaw && <pre className="raw-json">{JSON.stringify(r.details.raw, null, 2)}</pre>}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function RawModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['yandex-external', id], queryFn: () => api<{ external_number: string; raw: unknown; first_seen_at: string; last_seen_at: string }>(`/staff/yandex-sync/external/${id}`) });
  return (
    <Modal title={q.data ? `Ответ Яндекса: заказ ${q.data.external_number}` : 'Ответ Яндекса'} onClose={onClose} wide>
      {q.isPending ? (
        <Loading />
      ) : !q.data ? (
        <ErrorBox error={q.error} />
      ) : (
        <>
          <p className="muted small">
            Впервые увиден {dateTime(q.data.first_seen_at)}, последний раз {dateTime(q.data.last_seen_at)}.
          </p>
          <pre className="raw-json">{JSON.stringify(q.data.raw, null, 2)}</pre>
        </>
      )}
    </Modal>
  );
}

function CloseModal({ row, onClose }: { row: Attention; onClose: () => void }) {
  const client = useQueryClient();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/staff/yandex-sync/attention/${row.id}/close`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['yandex-sync'] });
      onClose();
    },
  });
  return (
    <Modal title={`Закрыть заказ ${row.external_number} как неактуальный?`} onClose={onClose}>
      <Help id="yandex-sync">
        Заказ уйдёт из «Требует внимания» навсегда: следующие опросы его не поднимут и уведомлений по нему не будет. Причина пишется в журнал
        аудита.
      </Help>
      <ReasonPicker options={CLOSE_REASONS} onChange={setReason} />
      <ErrorBox error={m.error} />
      <div className="modal-actions">
        <button className="btn" disabled={reason.length < 3 || m.isPending} onClick={() => m.mutate()}>
          Закрыть
        </button>
        <button className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
      </div>
    </Modal>
  );
}

/** «1 заказ», «2 заказа», «5 заказов», «21 заказ» */
export function ordersRu(n: number): string {
  const d = n % 10;
  const t = n % 100;
  const word = d === 1 && t !== 11 ? 'заказ' : d >= 2 && d <= 4 && (t < 12 || t > 14) ? 'заказа' : 'заказов';
  return `${n} ${word}`;
}

/** «Закрыть выбранные как неактуальные»: one shared reason, one request, all or nothing on the server. */
function CloseManyModal({ rows, onClose, onDone }: { rows: Attention[]; onClose: () => void; onDone: () => void }) {
  const client = useQueryClient();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api<{ closed: number; skipped: number }>('/staff/yandex-sync/attention/close-batch', { method: 'POST', body: { ids: rows.map((r) => r.id), reason } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['yandex-sync'] }),
  });
  const rejected = m.error instanceof ApiError ? (m.error.body.rejected as { external_number: string | null; reason: string }[] | undefined) : undefined;
  return (
    <Modal title={`Закрыть ${ordersRu(rows.length)}?`} onClose={onClose}>
      {m.data ? (
        <>
          <div className="alert alert-ok">
            Закрыто: {m.data.closed}
            {m.data.skipped ? `, пропущено (уже были закрыты): ${m.data.skipped}` : ''}.
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={onDone}>
              Готово
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">
            Заказы {rows.map((r) => r.external_number).join(', ')} уйдут из «Требует внимания» навсегда: следующие опросы их не поднимут и
            уведомлений не будет. Причина одна на все, пишется в журнал аудита по каждому заказу. Закрываются все сразу или ни один.
          </p>
          <ReasonPicker options={CLOSE_REASONS} onChange={setReason} />
          {rejected?.length ? (
            <div className="alert alert-error">
              {m.error instanceof Error ? m.error.message : ''}
              <ul>
                {rejected.map((r, i) => (
                  <li key={i}>
                    {r.external_number ?? 'запись'}: {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ErrorBox error={m.error} />
          )}
          <div className="modal-actions">
            <button className="btn" disabled={reason.length < 3 || m.isPending} onClick={() => m.mutate()}>
              Закрыть {ordersRu(rows.length)}
            </button>
            <button className="btn btn-ghost" onClick={onClose}>
              Отмена
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
