import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { AUDIENCE_LABELS, GOAL_LABELS, doseText, type Enrichment } from './EnrichDraft';
import { Badge, ErrorBox } from './ui';

interface Pending {
  progress: { running: boolean; total: number; done: number; failed: number };
  drafts: (Enrichment & {
    product: {
      id: string;
      sku: string;
      name: string;
      audience: string | null;
      goals: string[];
      substances: { id: string; name_ru: string; dose_amount: number | null; dose_unit: string | null }[];
    };
  })[];
}

/**
 * «Товары и вещества» → «Черновики VITALO AI»: one button drafts the substances, doses, audience and goals of all the
 * products (in the background, ~1 minute for 90), then the admin ticks and accepts them. Nothing changes before that.
 */
export function EnrichQueue({ canEdit }: { canEdit: boolean }) {
  const client = useQueryClient();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const q = useQuery({
    queryKey: ['compat', 'enrichments'],
    queryFn: () => api<Pending>('/staff/compat/enrichments'),
    refetchInterval: (query) => (query.state.data?.progress.running ? 3000 : false),
  });
  const done = (r: Pending) => {
    client.setQueryData(['compat', 'enrichments'], r);
    setPicked(new Set());
    void client.invalidateQueries({ queryKey: ['compat', 'products'] });
  };
  const all = useMutation({
    mutationFn: (onlyMissing: boolean) => api('/staff/compat/products/enrich-all', { method: 'POST', body: { only_missing: onlyMissing } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['compat', 'enrichments'] }),
  });
  const accept = useMutation({ mutationFn: (ids: string[]) => api<Pending>('/staff/compat/enrichments/accept', { method: 'POST', body: { ids } }), onSuccess: done });
  const reject = useMutation({ mutationFn: (ids: string[]) => api<Pending>('/staff/compat/enrichments/reject', { method: 'POST', body: { ids } }), onSuccess: done });

  const data = q.data;
  const drafts = data?.drafts ?? [];
  const running = data?.progress.running;
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const ids = [...picked];

  return (
    <section className="card enrich-queue">
      <h3>Черновики VITALO AI</h3>
      <p className="muted small">
        AI читает название и состав каждой карточки и предлагает вещества (с формами), дозы на порцию, кому подходит и цели. В карточки ничего не попадает,
        пока вы не отметите товары и не нажмёте «Принять». Ручные вещества, дозы и надписи при этом сохраняются.
      </p>
      {canEdit && (
        <div className="enrich-actions">
          <button type="button" className="btn btn-sm" disabled={all.isPending || running} onClick={() => all.mutate(true)}>
            Заполнить пустое у всех товаров
          </button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={all.isPending || running} onClick={() => all.mutate(false)}>
            Перепроверить все товары
          </button>
        </div>
      )}
      {running && (
        <p className="small">
          AI читает карточки: {data!.progress.done} из {data!.progress.total}
          {data!.progress.failed > 0 && `, не получилось ${data!.progress.failed}`}…
        </p>
      )}
      {!running && data && data.progress.total > 0 && data.progress.failed > 0 && (
        <p className="small text-bad">Не получилось у {data.progress.failed} товаров — повторите позже или откройте карточку и нажмите «Заполнить с помощью AI».</p>
      )}
      <ErrorBox error={q.error ?? all.error ?? accept.error ?? reject.error} />
      {drafts.length > 0 && (
        <>
          {canEdit && (
            <div className="enrich-actions">
              <label className="check small">
                <input type="checkbox" checked={picked.size === drafts.length} onChange={(e) => setPicked(e.target.checked ? new Set(drafts.map((d) => d.id)) : new Set())} />
                Выбрать все ({drafts.length})
              </label>
              <button type="button" className="btn btn-sm" disabled={!ids.length || accept.isPending} onClick={() => accept.mutate(ids)}>
                Принять выбранные ({ids.length})
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={!ids.length || reject.isPending} onClick={() => reject.mutate(ids)}>
                Отклонить
              </button>
            </div>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th />
                  <th>Товар</th>
                  <th>Сейчас</th>
                  <th>Предлагает AI</th>
                  <th>Кому · цели</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => {
                  const cur = new Set(d.product.substances.map((s) => s.id));
                  return (
                    <tr key={d.id}>
                      <td>{canEdit && <input type="checkbox" aria-label={`Выбрать ${d.product.sku}`} checked={picked.has(d.id)} onChange={() => toggle(d.id)} />}</td>
                      <td className="small">
                        <Link to={`/products/${d.product.id}#p-substances`}>{d.product.sku}</Link>
                        <div>{d.product.name}</div>
                      </td>
                      <td className="small">
                        {d.product.substances.length
                          ? d.product.substances.map((s) => `${s.name_ru}${doseText(s.dose_amount, s.dose_unit) ? ` ${doseText(s.dose_amount, s.dose_unit)}` : ''}`).join(', ')
                          : '—'}
                      </td>
                      <td className="small">
                        {d.payload.substances.map((s, i) => (
                          <span key={s.id}>
                            {i > 0 && ', '}
                            {cur.has(s.id) ? s.name_ru : <strong>{s.name_ru}</strong>}
                            {doseText(s.dose_amount, s.dose_unit) && ` ${doseText(s.dose_amount, s.dose_unit)}`}
                          </span>
                        ))}
                        {d.payload.unknown.length > 0 && <div className="text-bad">нет в справочнике: {d.payload.unknown.map((u) => u.name).join(', ')}</div>}
                        {d.payload.note && <div className="muted">{d.payload.note}</div>}
                      </td>
                      <td className="small">
                        <Badge tone="neutral">{AUDIENCE_LABELS[d.payload.audience] ?? d.payload.audience}</Badge>{' '}
                        {d.payload.goals.map((g) => GOAL_LABELS[g] ?? g).join(', ') || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {data && !drafts.length && !running && <p className="muted small">Черновиков нет.</p>}
    </section>
  );
}
