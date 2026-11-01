import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ErrorBox, Field, PageHead } from '../components/ui';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';

type LinkType = '' | 'product' | 'category' | 'brand';
interface SendResult {
  campaign: string;
  recipients: number;
  scheduled_at: string;
  deferred: boolean;
}

const LINK_HINT: Record<Exclude<LinkType, ''>, string> = {
  product: 'id товара (из адреса карточки товара в админке)',
  category: 'адрес категории (slug), например vitamins',
  brand: 'адрес бренда, как в разделе «Бренды»',
};

/**
 * 3.2: «Акции» — one message to every customer with «Получать акции и новости»: in the bot and in the Mini App centre.
 * Not sent from 22:00 to 08:00 (put off until the morning); the opt-out is checked again right before sending.
 */
export function Promo() {
  const audience = useQuery({ queryKey: ['promo', 'audience'], queryFn: () => api<{ recipients: number }>('/staff/promo/audience') });
  const [form, setForm] = useState({ title_ru: '', text_ru: '', title_uz: '', text_uz: '', link_type: '' as LinkType, link_value: '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const send = useMutation({
    mutationFn: () =>
      api<SendResult>('/staff/promo', {
        method: 'POST',
        body: {
          title_ru: form.title_ru,
          text_ru: form.text_ru,
          title_uz: form.title_uz || undefined,
          text_uz: form.text_uz || undefined,
          link: form.link_type && form.link_value.trim() ? { type: form.link_type, value: form.link_value.trim() } : undefined,
        },
      }),
    onSuccess: () => setForm({ title_ru: '', text_ru: '', title_uz: '', text_uz: '', link_type: '', link_value: '' }),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const n = audience.data?.recipients ?? 0;
    if (window.confirm(`Отправить акцию ${n} клиентам? Отменить отправку будет нельзя.`)) send.mutate();
  }

  return (
    <>
      <PageHead title="Рассылки" />
      <section className="card">
        <p className="muted">
          Сообщение придёт в бот и в «Уведомления» Mini App только клиентам, у которых включено «Получать акции и новости»
          {audience.data ? <> — сейчас таких <strong>{audience.data.recipients}</strong></> : null}. С 22:00 до 08:00 по Ташкенту
          акции не отправляются: отправка переносится на 08:00. Сообщения о заказах это правило не затрагивает.
        </p>
        <form onSubmit={onSubmit} className="form-grid">
          <Field label="Заголовок (RU)">
            <input value={form.title_ru} onChange={set('title_ru')} maxLength={80} required minLength={2} />
          </Field>
          <Field label="Заголовок (UZ)" hint="Пусто — клиенты с узбекским языком увидят русский текст">
            <input value={form.title_uz} onChange={set('title_uz')} maxLength={80} />
          </Field>
          <Field label="Текст (RU)">
            <textarea value={form.text_ru} onChange={set('text_ru')} maxLength={600} required minLength={2} rows={4} />
          </Field>
          <Field label="Текст (UZ)">
            <textarea value={form.text_uz} onChange={set('text_uz')} maxLength={600} rows={4} />
          </Field>
          <Field label="Кнопка «Открыть» ведёт на">
            <select value={form.link_type} onChange={set('link_type')}>
              <option value="">— без кнопки —</option>
              <option value="product">товар</option>
              <option value="category">категорию</option>
              <option value="brand">бренд</option>
            </select>
          </Field>
          {form.link_type && (
            <Field label="Куда" hint={LINK_HINT[form.link_type]}>
              <input value={form.link_value} onChange={set('link_value')} maxLength={120} required />
            </Field>
          )}
          <div>
            <button className="btn" disabled={send.isPending || !audience.data?.recipients}>
              Отправить
            </button>
          </div>
        </form>
        <ErrorBox error={send.error} />
        {send.data && (
          <div className="alert alert-ok" role="status">
            {send.data.deferred
              ? `Поставлено в очередь для ${send.data.recipients} клиентов, отправка в ${dateTime(send.data.scheduled_at)} (ночью акции не отправляются).`
              : `Отправляется ${send.data.recipients} клиентам.`}
          </div>
        )}
      </section>
    </>
  );
}
