import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ErrorBox, Field, PageHead, Help } from '../components/ui';
import { api, qs } from '../lib/api';
import { dateTime } from '../lib/format';
import { ProductPicker } from './Purchases';

type LinkType = '' | 'product' | 'category' | 'brand';
type Segment = 'all' | 'bought' | 'waiting' | 'inactive';
interface SendResult {
  campaign: string | null;
  recipients: number;
  scheduled_at: string;
  deferred: boolean;
  to_me?: boolean;
  would_reach?: number;
}
interface HistoryRow {
  id: string;
  created_at: string;
  staff_name: string | null;
  title_ru: string;
  segment: string;
  recipients: number;
  scheduled_at: string | null;
  sent: number;
  failed: number;
  read: number;
}

const LINK_HINT: Record<Exclude<LinkType, ''>, string> = {
  product: 'id товара (из адреса карточки товара в админке)',
  category: 'адрес категории (slug), например vitamins',
  brand: 'адрес бренда, как в разделе «Бренды»',
};
/** Аудит 4.2: groups of customers; always only those with «Получать акции и новости». */
const SEGMENTS: [Segment, string][] = [
  ['all', 'Все подписанные'],
  ['bought', 'Купили товар'],
  ['waiting', 'Ждут товар (лист ожидания)'],
  ['inactive', 'Без заказов N дней'],
];

/**
 * 3.2: «Рассылки» — a message in the bot and in the Mini App centre to customers with «Получать акции и новости».
 * Аудит 4.2: groups (bought / waiting for a product, no orders for N days), «Отправить себе», the history of sends.
 * Not sent from 22:00 to 08:00 (put off until the morning); the opt-out is checked again right before sending.
 */
export function Promo() {
  const client = useQueryClient();
  const [form, setForm] = useState({ title_ru: '', text_ru: '', title_uz: '', text_uz: '', link_type: '' as LinkType, link_value: '' });
  const [segment, setSegment] = useState<Segment>('all');
  const [product, setProduct] = useState<{ id: string; sku: string; name_ru: string } | null>(null);
  const [days, setDays] = useState('30');
  const needsProduct = segment === 'bought' || segment === 'waiting';
  const group = { segment, product_id: needsProduct ? product?.id : undefined, days: segment === 'inactive' ? Number(days) || 30 : undefined };
  const ready = !needsProduct || !!product;
  const audience = useQuery({
    queryKey: ['promo', 'audience', group],
    queryFn: () => api<{ recipients: number }>(`/staff/promo/audience${qs(group)}`),
    enabled: ready,
  });
  const history = useQuery({ queryKey: ['promo', 'history'], queryFn: () => api<HistoryRow[]>('/staff/promo/history') });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const send = useMutation({
    mutationFn: (toMe: boolean) =>
      api<SendResult>('/staff/promo', {
        method: 'POST',
        body: {
          ...group,
          to_me: toMe || undefined,
          title_ru: form.title_ru,
          text_ru: form.text_ru,
          title_uz: form.title_uz || undefined,
          text_uz: form.text_uz || undefined,
          link: form.link_type && form.link_value.trim() ? { type: form.link_type, value: form.link_value.trim() } : undefined,
        },
      }),
    onSuccess: (r) => {
      if (r.to_me) return; // the text stays: the test is usually followed by the real send
      setForm({ title_ru: '', text_ru: '', title_uz: '', text_uz: '', link_type: '', link_value: '' });
      void client.invalidateQueries({ queryKey: ['promo'] });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const n = audience.data?.recipients ?? 0;
    const name = SEGMENTS.find(([s]) => s === segment)![1];
    if (window.confirm(`Отправить рассылку «${name}»${product && needsProduct ? ` (${product.sku})` : ''}: ${n} клиентам? Отменить отправку будет нельзя.`)) send.mutate(false);
  }
  const canSendToMe = form.title_ru.trim().length >= 2 && form.text_ru.trim().length >= 2 && ready;

  return (
    <>
      <PageHead title="Рассылки" />
      <section className="card">
        <Help id="promo">
          Сообщение придёт в бот и в «Уведомления» Mini App только клиентам, у которых включено «Получать акции и новости». С 22:00 до 08:00 по Ташкенту
          рассылки не отправляются: отправка переносится на 08:00. Сообщения о заказах это правило не затрагивает. «Отправить себе» — только в ваш Telegram, сразу.
        </Help>
        <form onSubmit={onSubmit} className="form-grid">
          <Field label="Кому">
            <select value={segment} onChange={(e) => setSegment(e.target.value as Segment)}>
              {SEGMENTS.map(([s, l]) => (
                <option key={s} value={s}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {needsProduct && (
            <Field label="Товар">
              {product ? (
                <div className="row">
                  <span>
                    <strong>{product.sku}</strong> {product.name_ru}
                  </span>{' '}
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setProduct(null)}>
                    Другой товар
                  </button>
                </div>
              ) : (
                <ProductPicker exclude={[]} onPick={setProduct} />
              )}
            </Field>
          )}
          {segment === 'inactive' && (
            <Field label="Дней без заказа" hint="От 7 до 365; в группу входят и те, кто ещё не заказывал">
              <input type="number" min={7} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
            </Field>
          )}
          <p className="muted" role="status">
            {!ready ? 'Выберите товар' : audience.data ? <>Получат: <strong>{audience.data.recipients}</strong></> : 'Считаем…'}
          </p>
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
          <div className="page-actions">
            <button type="button" className="btn btn-ghost" disabled={send.isPending || !canSendToMe} onClick={() => send.mutate(true)}>
              Отправить себе
            </button>
            <button className="btn" disabled={send.isPending || !ready || !audience.data?.recipients}>
              Отправить
            </button>
          </div>
        </form>
        <ErrorBox error={send.error} />
        {send.data && (
          <div className="alert alert-ok" role="status">
            {send.data.to_me
              ? `Отправлено в ваш Telegram. Настоящая рассылка дойдёт до ${send.data.would_reach ?? 0} клиентов.`
              : send.data.deferred
                ? `Поставлено в очередь для ${send.data.recipients} клиентов, отправка в ${dateTime(send.data.scheduled_at)} (ночью рассылки не отправляются).`
                : `Отправляется ${send.data.recipients} клиентам.`}
          </div>
        )}
      </section>

      <section className="card flush">
        <div className="section-head pad">
          <h2>Отправленные рассылки</h2>
        </div>
        {history.isError ? (
          <ErrorBox error={history.error} />
        ) : !history.data?.length ? (
          <p className="muted pad">Рассылок ещё не было</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Заголовок</th>
                <th>Кому</th>
                <th className="num">Получателей</th>
                <th className="num">Доставлено</th>
                <th className="num" title="Открыли сообщение в «Уведомлениях» Mini App; открытия в самом боте Telegram не сообщает">
                  Открыли в Mini App
                </th>
              </tr>
            </thead>
            <tbody>
              {history.data.map((h) => (
                <tr key={h.id}>
                  <td>
                    {dateTime(h.created_at)}
                    {h.staff_name && <div className="muted small">{h.staff_name}</div>}
                  </td>
                  <td>{h.title_ru}</td>
                  <td>{h.segment}</td>
                  <td className="num">{h.recipients}</td>
                  <td className="num">
                    {h.sent}
                    {h.failed > 0 && <div className="text-warn small">не дошло: {h.failed}</div>}
                  </td>
                  <td className="num">
                    {h.read}
                    {h.sent > 0 && <span className="muted small"> ({Math.round((h.read / h.sent) * 100)} %)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
