import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { dateTime, money } from '../lib/format';
import { ErrorBox, Field, Modal } from './ui';

export interface CustomerBonusInfo {
  balance_uzs: number;
  expires_on: string | null;
  history: { id: string; op: string; amount_uzs: number; balance_after_uzs: number; order_id: string | null; order_number: string | null; created_at: string }[];
}

const OP: Record<string, string> = {
  purchase: 'Кешбэк за заказ',
  redemption: 'Оплата заказа',
  manual_add: 'Начислено вручную',
  manual_subtract: 'Списано вручную',
  expire: 'Сгорели',
  review: 'За отзыв',
  promo: 'Начисление',
  referral: 'Начисление',
};
const opLabel = (op: string, amount: number) => (op === 'reversal' ? (amount > 0 ? 'Вернулись после отмены / возврата' : 'Кешбэк отменён (возврат)') : OP[op] ?? op);
const dmy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

/** 3.10-А: «Бонусы» on the customer card — balance, when it burns, history; «+ Начислить» / «− Списать» for admins. */
export function CustomerBonus({ customerId, bonus }: { customerId: string; bonus: CustomerBonusInfo }) {
  const { can } = useSession();
  const client = useQueryClient();
  const [mode, setMode] = useState<'add' | 'sub' | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const change = useMutation({
    mutationFn: () => api<{ balance_uzs: number }>(`/staff/bonus/customers/${customerId}`, { method: 'POST', body: { amount: (mode === 'sub' ? -1 : 1) * Number(amount), reason } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['customer', customerId] });
      setMode(null);
      setAmount('');
      setReason('');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    change.mutate();
  };
  return (
    <section className="card">
      <h2>Бонусы</h2>
      <p>
        <strong>{money(bonus.balance_uzs)}</strong>
        {bonus.expires_on && <span className="muted small"> · сгорят {dmy(bonus.expires_on)}</span>}
      </p>
      {can('bonus.manage') && (
        <div className="page-actions">
          <button className="btn btn-sm" onClick={() => setMode('add')}>
            + Начислить
          </button>
          <button className="btn btn-sm btn-ghost" disabled={bonus.balance_uzs <= 0} onClick={() => setMode('sub')}>
            − Списать
          </button>
        </div>
      )}
      {bonus.history.length === 0 ? (
        <p className="muted small">Операций пока нет</p>
      ) : (
        <table className="table">
          <tbody>
            {bonus.history.map((h) => (
              <tr key={h.id}>
                <td>
                  {opLabel(h.op, h.amount_uzs)}
                  {h.order_number && <span className="muted small"> · {h.order_number}</span>}
                </td>
                <td className="muted small">{dateTime(h.created_at)}</td>
                <td className="num">
                  {h.amount_uzs > 0 ? '+' : '−'}
                  {money(Math.abs(h.amount_uzs))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {mode && (
        <Modal title={mode === 'add' ? 'Начислить бонусы' : 'Списать бонусы'} onClose={() => setMode(null)}>
          <form onSubmit={submit}>
            <Field label="Сумма, сум" hint={mode === 'sub' ? `на счёте ${money(bonus.balance_uzs)}` : 'клиент получит сообщение в бот'}>
              <input type="number" min={1} max={mode === 'sub' ? bonus.balance_uzs : 10_000_000} step={1} required value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Причина" hint="обязательно; видна в журнале аудита">
              <input value={reason} maxLength={300} required onChange={(e) => setReason(e.target.value)} placeholder="Например: компенсация за задержку заказа" />
            </Field>
            <ErrorBox error={change.error} />
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setMode(null)}>
                Отмена
              </button>
              <button className="btn" disabled={change.isPending || !(Number(amount) > 0) || !reason.trim()}>
                {mode === 'add' ? 'Начислить' : 'Списать'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
