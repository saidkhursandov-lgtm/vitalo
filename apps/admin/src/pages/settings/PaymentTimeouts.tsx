import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ErrorBox, Field, Loading } from '../../components/ui';
import { api } from '../../lib/api';

interface Method {
  code: string;
  name_ru: string;
  status: string;
  timeout_minutes: number;
}

const hours = (min: number) => (min % 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин` : `${min / 60} ч`);

/**
 * How long an unpaid order holds the goods (card / bank transfer), 30–1440 minutes.
 * Only new orders get a new time: existing orders keep the deadline they were created with.
 */
export function PaymentTimeouts() {
  const q = useQuery({ queryKey: ['settings', 'payment-methods'], queryFn: () => api<Method[]>('/staff/settings/payment-methods') });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <section className="card narrow">
      <h2>Срок резерва неоплаченного заказа</h2>
      <p className="muted">
        Сколько товар держится за заказом, пока клиент не оплатил. Потом заказ отменяется автоматически. Новый срок действует только для новых заказов.
      </p>
      {q.data.map((m) => (
        <TimeoutRow key={m.code} method={m} />
      ))}
    </section>
  );
}

function TimeoutRow({ method }: { method: Method }) {
  const client = useQueryClient();
  const [value, setValue] = useState(String(method.timeout_minutes));
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api<Method[]>(`/staff/settings/payment-methods/${method.code}`, { method: 'PUT', body: { timeout_minutes: Number(value) } }),
    onSuccess: (list) => {
      client.setQueryData(['settings', 'payment-methods'], list);
      setSaved(true);
    },
  });
  const minutes = Number(value);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit}>
      <div className="form-grid">
        <Field label={`${method.name_ru}, минут`} hint={Number.isInteger(minutes) && minutes > 0 ? `= ${hours(minutes)} (30–1440 минут)` : '30–1440 минут'}>
          <input
            type="number"
            min={30}
            max={1440}
            step={1}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            required
          />
        </Field>
      </div>
      <ErrorBox error={save.error} />
      {saved && <div className="alert alert-ok">Сохранено</div>}
      <button className="btn" disabled={save.isPending || String(method.timeout_minutes) === value}>
        Сохранить
      </button>
    </form>
  );
}
