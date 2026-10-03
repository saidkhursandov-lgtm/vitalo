import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { ErrorBox, Field, Loading } from '../../components/ui';
import { api } from '../../lib/api';

interface Contacts {
  support_contact: string;
  payment_check_from: string;
  payment_check_to: string;
  delivery_days_label: { ru: string; uz: string };
}

/** Support contact (bot and Mini App), payment check hours (screen after «Я оплатил(а)»), «рабочих дней» label. */
export function ContactsForm() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'contacts'], queryFn: () => api<Contacts>('/staff/settings/contacts') });
  const [f, setF] = useState<Contacts | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<Contacts>('/staff/settings/contacts', { method: 'PUT', body: f }),
    onSuccess: (c) => {
      client.setQueryData(['settings', 'contacts'], c);
      setSaved(true);
    },
  });
  if (q.isPending || !f) return <Loading />;
  const set = (patch: Partial<Contacts>) => {
    setF({ ...f, ...patch });
    setSaved(false);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const handle = f.support_contact.replace(/^(https?:\/\/)?(t\.me\/|@)?/, '');

  return (
    <form className="card narrow" onSubmit={submit}>
      <h2>Поддержка и время работы</h2>
      <div className="form-grid">
        <Field label="Контакт поддержки (Telegram)" hint={handle ? `Ссылка: t.me/${handle}` : '@username'}>
          <input value={f.support_contact} onChange={(e) => set({ support_contact: e.target.value })} required />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Проверяем платежи с" hint="Время Ташкента">
          <input type="time" value={f.payment_check_from} onChange={(e) => set({ payment_check_from: e.target.value })} required />
        </Field>
        <Field label="до">
          <input type="time" value={f.payment_check_to} onChange={(e) => set({ payment_check_to: e.target.value })} required />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Подпись срока доставки (RU)" hint="«2–5 рабочих дней»">
          <input value={f.delivery_days_label.ru} onChange={(e) => set({ delivery_days_label: { ...f.delivery_days_label, ru: e.target.value } })} required />
        </Field>
        <Field label="Подпись срока доставки (UZ)">
          <input value={f.delivery_days_label.uz} onChange={(e) => set({ delivery_days_label: { ...f.delivery_days_label, uz: e.target.value } })} required />
        </Field>
      </div>
      <ErrorBox error={save.error} />
      {saved && <div className="alert alert-ok">Сохранено</div>}
      <button className="btn" disabled={save.isPending}>
        Сохранить
      </button>
    </form>
  );
}
