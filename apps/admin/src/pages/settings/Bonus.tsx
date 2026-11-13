import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { ErrorBox, Field, Help, Loading } from '../../components/ui';
import { api } from '../../lib/api';
import { money } from '../../lib/format';

export interface BonusSettings {
  enabled: boolean;
  cashback_pct: number;
  max_spend_pct: number;
  lifetime_days: number;
  remind_days: number;
  review_uzs: number;
  review_photo_uzs: number;
}

interface BonusStats {
  month: string;
  accrued_uzs: number;
  spent_uzs: number;
  refunded_uzs: number;
  taken_uzs: number;
  expired_uzs: number;
  owed_uzs: number;
  customers_with_balance: number;
}

const FIELDS: { key: Exclude<keyof BonusSettings, 'enabled'>; label: string; min: number; max: number; hint: string }[] = [
  { key: 'cashback_pct', label: 'Кешбэк, %', min: 0, max: 10, hint: 'от оплаченных товаров, после «Доставлен» (0–10)' },
  { key: 'max_spend_pct', label: 'Оплата бонусами, до % товаров', min: 0, max: 50, hint: 'доставка всегда деньгами (0–50)' },
  { key: 'lifetime_days', label: 'Срок жизни, дней', min: 30, max: 730, hint: 'с последнего начисления (30–730)' },
  { key: 'remind_days', label: 'Напомнить за, дней', min: 1, max: 30, hint: 'сообщение в бот «сгорят N сум» (1–30)' },
  { key: 'review_uzs', label: 'Бонус за отзыв, сум', min: 0, max: 100_000, hint: 'без фото (подэтап 3.10-Б)' },
  { key: 'review_photo_uzs', label: 'Бонус за отзыв с фото, сум', min: 0, max: 100_000, hint: '(подэтап 3.10-Б)' },
];

const thisMonth = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 7);

/** 3.10-А (D-71): «Настройки → VITALO Bonus» and the numbers of a month. Admin only. */
export function BonusSettingsPage() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'bonus'], queryFn: () => api<BonusSettings>('/staff/bonus/settings') });
  const [form, setForm] = useState<BonusSettings | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data && !form) setForm(q.data);
  }, [q.data, form]);
  const save = useMutation({
    mutationFn: (body: BonusSettings) => api<BonusSettings>('/staff/bonus/settings', { method: 'PUT', body }),
    onSuccess: (s) => {
      client.setQueryData(['settings', 'bonus'], s);
      setForm(s);
      setSaved(true);
    },
  });
  if (q.isPending || !form) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const set = (patch: Partial<BonusSettings>) => {
    setForm({ ...form, ...patch });
    setSaved(false);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(form);
  };
  return (
    <>
      <section className="card narrow">
        <h2>VITALO Bonus</h2>
        <Help id="bonus-settings">
          1 бонус = 1 сум. Кешбэк начисляется после статуса «Доставлен» и оплаты, по проценту, который был при оформлении заказа. Бонусы нельзя списать вместе с промокодом и на товары со скидкой больше 15%; защита маржи промокодов действует и для бонусов. Выключение не трогает балансы: клиенты перестают получать и тратить бонусы.
        </Help>
        <form onSubmit={submit}>
          <label className="check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Бонусная программа включена
          </label>
          <div className="form-grid">
            {FIELDS.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint}>
                <input type="number" min={f.min} max={f.max} step={1} required value={form[f.key]} onChange={(e) => set({ [f.key]: Number(e.target.value) } as Partial<BonusSettings>)} />
              </Field>
            ))}
          </div>
          <ErrorBox error={save.error} />
          {saved && <div className="alert alert-ok">Сохранено</div>}
          <button className="btn" disabled={save.isPending || JSON.stringify(form) === JSON.stringify(q.data)}>
            Сохранить
          </button>
        </form>
      </section>
      <BonusMonth />
    </>
  );
}

function BonusMonth() {
  const [month, setMonth] = useState(thisMonth());
  const q = useQuery({ queryKey: ['bonus-stats', month], queryFn: () => api<BonusStats>(`/staff/bonus/stats?month=${month}`) });
  return (
    <section className="card narrow">
      <h2>Бонусы за месяц</h2>
      <div className="filters">
        <Field label="Месяц">
          <input type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </Field>
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <dl className="props">
          <dt>Начислено</dt>
          <dd>{money(q.data.accrued_uzs)}</dd>
          <dt>Списано в оплату заказов</dt>
          <dd>{money(q.data.spent_uzs)}</dd>
          <dt>Вернулось после отмен и возвратов</dt>
          <dd>{money(q.data.refunded_uzs)}</dd>
          <dt>Забрано (возвраты, «− Списать»)</dt>
          <dd>{money(q.data.taken_uzs)}</dd>
          <dt>Сгорело</dt>
          <dd>{money(q.data.expired_uzs)}</dd>
          <dt>Остаток на счетах сейчас</dt>
          <dd>
            <strong>{money(q.data.owed_uzs)}</strong> <span className="muted small">у {q.data.customers_with_balance} клиентов</span>
          </dd>
        </dl>
      )}
      <p className="muted small">Списанные бонусы уменьшают выручку заказа, как промокод. Остаток на счетах — обязательство магазина перед клиентами.</p>
    </section>
  );
}
