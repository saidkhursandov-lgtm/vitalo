import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { REASONS, ReasonPicker } from '../components/Reason';
import { Badge, ErrorBox, Field, Modal } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { money, ruDate, UNIT_STATUS } from '../lib/format';
import type { AdminOrder } from './OrderDetail';

/**
 * Stage 2E «Сборка» of a Mini App order: the jars (Physical ID) of unit-tracked lines. Reserved by FEFO when the
 * payment is confirmed; the warehouse confirms each jar by typing or scanning its Physical ID (another jar of the
 * same product replaces a reserved one; not the earliest expiry → a reason). Costs and profit come from the server
 * only for the admin. The manager sees the block without the input.
 */
export interface Assembly {
  attention: string | null;
  assembling: boolean;
  all_picked: boolean;
  legacy: boolean;
  lines: {
    order_item_id: string;
    sku: string;
    name: string;
    qty: number;
    picked: number;
    units: { unit_id: string; physical_id: string; expiry_date: string; status: string; picked: boolean; fefo_override: string | null; cost_uzs?: number }[];
    recommended: { physical_id: string; expiry_date: string } | null;
    released: { physical_id: string; status: string; reason: string | null; return_decision: string | null }[];
    money?: { paid_uzs: number; cost_uzs: number; profit_uzs: number };
  }[];
}

type Done = (o: AdminOrder & { message?: string }) => void;

export function OrderAssembly({ order, onDone }: { order: AdminOrder; onDone: Done }) {
  const a = order.assembly;
  const canAct = order.actions.units;
  const [message, setMessage] = useState<string | null>(null);
  const done: Done = (o) => {
    setMessage(o.message ?? null);
    onDone(o);
  };
  const reserve = useMutation({
    mutationFn: () => api<AdminOrder & { message?: string }>(`/staff/orders/${order.id}/units/reserve`, { method: 'POST' }),
    onSuccess: done,
  });
  if (!a) return null;
  const anyMoney = a.lines.some((l) => l.money);
  return (
    <section className="card">
      <div className="section-head">
        <h2>Сборка: банки заказа</h2>
        {a.assembling && !a.attention && !a.legacy && (a.all_picked ? <Badge tone="ok">все банки собраны</Badge> : <Badge tone="warn">ждёт сборки</Badge>)}
      </div>
      {message && <div className="alert alert-ok">{message}</div>}
      {a.attention && (
        <div className="alert alert-warn">
          <strong>Нужно внимание склада.</strong> Заказ оплачен, но банки не закреплены: {a.attention}. Клиент этого не видит. Когда банки появятся
          (приёмка, «Найдена», возврат), нажмите «Зарезервировать банки».
          {canAct && (
            <div style={{ marginTop: 8 }}>
              <button className="btn" disabled={reserve.isPending} onClick={() => reserve.mutate()}>
                Зарезервировать банки
              </button>
            </div>
          )}
          <ErrorBox error={reserve.error} />
        </div>
      )}
      {a.legacy && (
        <div className="alert alert-info">
          Заказ оплачен до перехода на учёт по банкам: количество уже списано при оплате, банки к нему не привязаны. Он собирается по-старому.
        </div>
      )}
      {canAct && a.assembling && !a.attention && !a.legacy && !a.all_picked && <PickBox order={order} onDone={done} />}

      {!a.legacy && (
        <table className="table">
          <thead>
            <tr>
              <th>Товар</th>
              <th className="num">Нужно</th>
              <th>Банки</th>
              {anyMoney && <th className="num">Прибыль</th>}
            </tr>
          </thead>
          <tbody>
            {a.lines.map((l) => (
              <tr key={l.order_item_id}>
                <td>
                  <strong>{l.sku}</strong>
                  <div className="muted small">{l.name}</div>
                </td>
                <td className="num">
                  {a.assembling ? `${l.picked} из ${l.qty}` : l.qty}
                </td>
                <td>
                  {l.units.map((u) => (
                    <div key={u.unit_id} className="small">
                      <span className="id-chip">{u.physical_id}</span> срок {ruDate(u.expiry_date)} ·{' '}
                      {a.assembling ? u.picked ? <Badge tone="ok">собрана</Badge> : <Badge tone="warn">взять с полки</Badge> : <Badge>{UNIT_STATUS[u.status] ?? u.status}</Badge>}
                      {u.fefo_override && <span className="muted"> · не ранний срок: {u.fefo_override}</span>}
                      {u.cost_uzs !== undefined && <span className="muted"> · себестоимость {money(u.cost_uzs)}</span>}
                    </div>
                  ))}
                  {!l.units.length && <span className="muted small">банки не закреплены</span>}
                  {l.recommended && (
                    <div className="muted small">
                      Рекомендуем {l.recommended.physical_id}, срок {ruDate(l.recommended.expiry_date)}
                    </div>
                  )}
                  {l.released.map((r, i) => (
                    <div key={i} className="muted small">
                      снята: {r.physical_id} ({UNIT_STATUS[r.status] ?? r.status}){r.reason ? ` — ${r.reason}` : ''}
                    </div>
                  ))}
                </td>
                {anyMoney && (
                  <td className="num">
                    {l.money ? (
                      <>
                        <strong className={l.money.profit_uzs < 0 ? 'text-warn' : ''}>{money(l.money.profit_uzs)}</strong>
                        <div className="muted small">
                          {money(l.money.paid_uzs)} − {money(l.money.cost_uzs)}
                        </div>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {anyMoney && <p className="muted small">Прибыль = оплаченная цена − себестоимость этих банок (видит только администратор). Доставка не учитывается.</p>}
      {a.assembling && !a.attention && !a.legacy && !a.all_picked && (
        <p className="muted small">«Передан в доставку» станет возможным, когда все банки отмечены по Physical ID. Остаток уменьшится в момент передачи.</p>
      )}
    </section>
  );
}

/** Physical ID field; on «not the earliest expiry» asks for a reason and sends again. */
function PickBox({ order, onDone }: { order: AdminOrder; onDone: Done }) {
  const [code, setCode] = useState('');
  const [fefo, setFefo] = useState<{ code: string; message: string } | null>(null);
  const [reason, setReason] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const pick = useMutation({
    mutationFn: (body: { physical_id: string; fefo_reason?: string }) => api<AdminOrder & { message?: string }>(`/staff/orders/${order.id}/units/pick`, { method: 'POST', body }),
    onSuccess: (o) => {
      setCode('');
      setFefo(null);
      onDone(o);
    },
    onError: (e, body) => {
      if (e instanceof ApiError && e.code === 'FEFO_REASON_REQUIRED') setFefo({ code: body.physical_id, message: e.message });
    },
    onSettled: () => input.current?.focus(),
  });
  const fefoError = pick.error instanceof ApiError && pick.error.code === 'FEFO_REASON_REQUIRED';
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) pick.mutate({ physical_id: code.trim() });
        }}
      >
        <Field label="Введите или отсканируйте Physical ID банки и нажмите Enter" hint="Подходит V-000184, 000184 или 184. Другая банка того же товара заменит зарезервированную.">
          <input ref={input} className="scan-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="V-000184" autoComplete="off" />
        </Field>
      </form>
      {!fefoError && <ErrorBox error={pick.error} />}
      {fefo && (
        <Modal title="Не самый ранний срок годности" onClose={() => setFefo(null)}>
          <div className="alert alert-warn">{fefo.message}</div>
          <ReasonPicker options={REASONS.fefo} onChange={setReason} label="Почему берёте эту банку" />
          <ErrorBox error={fefoError ? null : pick.error} />
          <div className="modal-actions">
            <button className="btn" disabled={reason.length < 3 || pick.isPending} onClick={() => pick.mutate({ physical_id: fefo.code, fefo_reason: reason })}>
              Взять {fefo.code} с причиной
            </button>
            <button className="btn btn-ghost" onClick={() => setFefo(null)}>
              Взять рекомендованную
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** «Оформить возврат» after the handover (warehouse, admin): the jars wait for a check on the warehouse screen. */
export function ReturnOrderModal({ order, onDone, onClose }: { order: AdminOrder; onDone: Done; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api<AdminOrder & { message?: string }>(`/staff/orders/${order.id}/return`, { method: 'POST', body: { reason } }),
    onSuccess: onDone,
  });
  return (
    <Modal title={`Оформить возврат заказа ${order.order_number}?`} onClose={onClose}>
      <p>
        Заказ станет «{order.status === 'delivered' ? 'Возврат' : 'Отменён'}». Банки с Physical ID перейдут в «Возврат на проверке» — решение по каждой
        принимается в «Склад → Единицы → Возвраты на проверке». Менеджеру создаётся задача вернуть деньги клиенту.
      </p>
      <ReasonPicker options={REASONS.return} onChange={setReason} />
      <ErrorBox error={m.error} />
      <div className="modal-actions">
        <button className="btn" disabled={reason.length < 3 || m.isPending} onClick={() => m.mutate()}>
          Оформить возврат
        </button>
        <button className="btn btn-ghost" onClick={onClose}>
          Назад
        </button>
      </div>
    </Modal>
  );
}
