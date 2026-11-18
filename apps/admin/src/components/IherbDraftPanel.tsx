import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { money } from '../lib/format';
import type { PickedSubstance } from './SubstancePicker';
import { ErrorBox } from './ui';

/** The answer of POST /staff/products/iherb/draft (apps/api iherb-add.service.ts). */
export interface IherbDraft {
  duplicate: { id: string; sku: string; name_ru: string; status: string } | null;
  draft?: Record<string, unknown> & { substances: { id: string }[]; category_ids: string[] };
  photos?: string[];
  iherb?: { product_id: string; url: string; price_uzs: number | null; price_source: 'page' | 'ai' | null; in_stock: boolean | null; title: string | null; iherb_code: string | null; upc: string | null };
  enrichment?: { substances: PickedSubstance[]; note: string } | null;
  unknown?: { name: string; dose: string | null; name_uz: string; synonyms: string[] }[];
  similar?: { id: string; sku: string; name_ru: string; brand: string; status: string; iherb_product_id: string | null }[];
  problems?: string[];
  note?: string;
  cost_usd?: number;
  /** D-79: the other pack sizes on the iHerb page; ours — already in the shop */
  variants?: { product_id: string; label: string; label_ru: string | null; price_uzs: number | null; url: string | null; ours: { id: string; sku: string; name_ru: string; status: string } | null }[];
  /** D-79: the card was copied from this pack size (no AI) */
  copied_from?: { id: string; sku: string; name_ru: string } | null;
}

const STATUS: Record<string, string> = { active: 'в продаже', hidden: 'скрыт', archived: 'в архиве' };

/**
 * D-78: what AI made of the iHerb page and what the person must check — shown above the product editor until
 * «Создать товар». Photos are picked here and downloaded after the product is created.
 */
export function IherbDraftPanel({
  data,
  photos,
  onPhotos,
  onSubstanceAdded,
}: {
  data: IherbDraft;
  photos: string[];
  onPhotos: (urls: string[]) => void;
  onSubstanceAdded: (s: PickedSubstance) => void;
}) {
  const { can } = useSession();
  const iherb = data.iherb;
  return (
    <section className="card" aria-label="Черновик из iHerb">
      <h2>Черновик из iHerb — проверьте перед созданием</h2>
      <p className="muted small">
        AI заполнил карточку по странице{' '}
        <a href={iherb?.url} target="_blank" rel="noreferrer">
          iHerb {iherb?.product_id}
        </a>
        {iherb?.iherb_code ? ` (${iherb.iherb_code})` : ''}. Проверьте дозы и формы веществ, узбекский текст, цену и предупреждения. Товар создастся скрытым.
        {data.cost_usd != null && ` Стоимость AI: $${data.cost_usd.toFixed(3)}.`}
      </p>
      {iherb?.price_uzs ? (
        <p>
          Цена iHerb: <strong>{money(iherb.price_uzs)}</strong>
          {iherb.price_source === 'ai' && <span className="text-warn"> (прочитал AI — сверьте со страницей)</span>} → цена VITALO по автоцене (+80%):{' '}
          <strong>{money(Number(data.draft?.price_uzs ?? 0))}</strong>
        </p>
      ) : null}
      {!!data.problems?.length && (
        <div className="alert alert-warn" role="alert">
          <strong>Проверьте:</strong>
          <ul>
            {data.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {data.note && <p className="small">Заметка AI: {data.note}</p>}
      {!!data.variants?.length && (
        <div>
          <h3>Другие фасовки на iHerb</h3>
          <p className="muted small">
            Эта фасовка: <strong>{String(data.draft?.variant_label_ru ?? '—')}</strong>. Фасовки, которые уже есть в магазине, связываются с новым товаром сами (блок «Фасовки» ниже).
          </p>
          <ul className="small" aria-label="Фасовки на iHerb">
            {data.variants.map((v) => (
              <li key={v.product_id}>
                {v.label_ru ?? v.label}
                {v.price_uzs ? ` — ${money(v.price_uzs)} на iHerb` : ''}{' '}
                {v.ours ? (
                  <Link to={`/products/${v.ours.id}`} target="_blank">
                    есть в магазине: {v.ours.sku}
                  </Link>
                ) : (
                  <span className="muted">нет в магазине</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!data.similar?.length && (
        <div className="alert alert-warn">
          <strong>Похожие товары уже есть — не дубль ли это?</strong>
          <ul>
            {data.similar.map((s) => (
              <li key={s.id}>
                <Link to={`/products/${s.id}`} target="_blank">
                  {s.sku} — {s.name_ru}
                </Link>{' '}
                <span className="muted">({STATUS[s.status] ?? s.status})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!data.unknown?.length && (
        <div>
          <h3>Веществ нет в справочнике</h3>
          <p className="muted small">Без них VITALO AI не учтёт эти вещества в совместимости и «Идеальной паре». Добавьте их — AI предложит правила совместимости, их утверждает администратор.</p>
          {data.unknown.map((u) => (
            <UnknownRow key={u.name} u={u} canAdd={can('compat.answer')} onAdded={onSubstanceAdded} />
          ))}
        </div>
      )}
      {!!data.photos?.length && (
        <div>
          <h3>Фото с iHerb</h3>
          <p className="muted small">Отмеченные фото скачаются после «Создать товар». Первое станет главным.</p>
          <div className="iherb-photos">
            {data.photos.map((u, i) => (
              <label key={u} className="check">
                <input type="checkbox" aria-label={`Фото ${i + 1}`} checked={photos.includes(u)} onChange={(e) => onPhotos(e.target.checked ? data.photos!.filter((x) => x === u || photos.includes(x)) : photos.filter((x) => x !== u))} />
                <img src={u} alt="" loading="lazy" />
              </label>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

interface DictSubstance {
  id: string;
  kind: string;
  name_ru: string;
  name_uz: string;
}

function UnknownRow({ u, canAdd, onAdded }: { u: { name: string; dose: string | null; name_uz: string; synonyms: string[] }; canAdd: boolean; onAdded: (s: PickedSubstance) => void }) {
  const [nameRu, setNameRu] = useState(u.name);
  const [nameUz, setNameUz] = useState(u.name_uz);
  const [added, setAdded] = useState<DictSubstance | null>(null);
  const add = useMutation({
    mutationFn: () => api<DictSubstance[]>('/staff/compat/substances', { method: 'POST', body: { name_ru: nameRu.trim(), name_uz: nameUz.trim(), synonyms: u.synonyms, kind: 'substance' } }),
    onSuccess: (list) => {
      const s = list.find((x) => x.name_ru === nameRu.trim());
      if (!s) return;
      setAdded(s);
      onAdded({ id: s.id, kind: s.kind, name_ru: s.name_ru, name_uz: s.name_uz, parent_name: null, in_label: false, dose_amount: null, dose_unit: null });
    },
  });
  const rules = useMutation({
    mutationFn: () => api<{ created: number }>(`/staff/compat/substances/${added!.id}/suggest-rules`, { method: 'POST' }),
  });
  return (
    <div className="unknown-row">
      {added ? (
        <p>
          <strong>{added.name_ru}</strong> добавлено в справочник и в состав товара{u.dose ? ` (доза по этикетке: ${u.dose} — впишите в составе)` : ''}.{' '}
          {rules.data ? (
            <span>
              AI предложил правил: {rules.data.created}. Они в <Link to="/compat">«Совместимость → Правила»</Link> как черновики — их утверждает администратор.
            </span>
          ) : (
            <button type="button" className="btn btn-ghost" disabled={rules.isPending} onClick={() => rules.mutate()}>
              {rules.isPending ? 'AI думает…' : 'Предложить правила совместимости'}
            </button>
          )}
        </p>
      ) : (
        <div className="form-row">
          <input aria-label="Название по-русски" value={nameRu} onChange={(e) => setNameRu(e.target.value)} />
          <input aria-label="Название по-узбекски" value={nameUz} onChange={(e) => setNameUz(e.target.value)} placeholder="O‘zbekcha nomi" />
          <span className="muted small">{u.dose ?? ''}</span>
          {canAdd && (
            <button type="button" className="btn btn-ghost" disabled={add.isPending || nameRu.trim().length < 2 || nameUz.trim().length < 2} onClick={() => add.mutate()}>
              Добавить в справочник
            </button>
          )}
        </div>
      )}
      <ErrorBox error={add.error ?? rules.error} />
    </div>
  );
}
