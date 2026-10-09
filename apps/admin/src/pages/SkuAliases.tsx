import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ErrorBox, Field, Loading } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';

interface Alias {
  id: string;
  alias: string;
  source: 'yandex' | 'internal';
  created_at: string;
}

const SOURCE: Record<Alias['source'], string> = { yandex: 'старый SKU в Яндексе', internal: 'прежний SKU у нас' };

/**
 * «Альтернативные SKU» in the product card: old codes by which the Yandex sync and the product search find this
 * product. Everyone with access to products sees them; only the admin adds and removes (audit log).
 */
export function SkuAliases({ productId, sku }: { productId: string; sku: string }) {
  const { can } = useSession();
  const editable = can('products.aliases');
  const client = useQueryClient();
  const key = ['product-aliases', productId];
  const q = useQuery({ queryKey: key, queryFn: () => api<Alias[]>(`/staff/products/${productId}/aliases`) });
  const [alias, setAlias] = useState('');
  const [source, setSource] = useState<Alias['source']>('yandex');
  const add = useMutation({
    mutationFn: () => api<Alias>(`/staff/products/${productId}/aliases`, { method: 'POST', body: { alias: alias.trim(), source } }),
    onSuccess: () => {
      setAlias('');
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/staff/products/${productId}/aliases/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: key }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <section className="card">
      <div className="section-head">
        <h2>Альтернативные SKU</h2>
      </div>
      <p className="muted small">
        Старые коды товара {sku}: по ним синхронизация Яндекса и поиск находят этот товар, если код в заказе отличается от SKU.
      </p>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data.length ? (
        <p className="muted">Нет.</p>
      ) : (
        <ul className="plain-list">
          {q.data.map((a) => (
            <li key={a.id}>
              <span className="id-chip">{a.alias}</span> <span className="muted small">{SOURCE[a.source]}</span>
              {editable && (
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm(`Удалить альтернативный SKU ${a.alias}?`)) remove.mutate(a.id);
                  }}
                >
                  Удалить
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorBox error={remove.error} />
      {editable && (
        <form onSubmit={submit}>
          <div className="form-grid">
            <Field label="Добавить код" hint="Латиница, цифры и . _ / -, без пробелов">
              <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="TPRD-031" maxLength={64} />
            </Field>
            <Field label="Откуда код">
              <select value={source} onChange={(e) => setSource(e.target.value as Alias['source'])}>
                <option value="yandex">{SOURCE.yandex}</option>
                <option value="internal">{SOURCE.internal}</option>
              </select>
            </Field>
          </div>
          <ErrorBox error={add.error} />
          <button className="btn" disabled={add.isPending || alias.trim().length < 2}>
            Добавить
          </button>
        </form>
      )}
    </section>
  );
}
