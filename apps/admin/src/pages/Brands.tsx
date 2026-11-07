import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead, toInt } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useSession } from '../lib/auth';
import { dictionaryKey } from '../components/DictionarySelect';

interface Brand {
  id: string;
  name_ru: string;
  status: 'active' | 'archived';
  slug: string | null;
  logo_url: string | null;
  country_ru: string | null;
  country_uz: string | null;
  why_vitalo_ru: string | null;
  why_vitalo_uz: string | null;
  show_in_showcase: boolean;
  sort_order: number;
  products: number;
  products_active: number;
  products_in_stock: number;
  shown_in_showcase: boolean;
}
interface BrandList {
  items: Brand[];
  logo: { width: number; height: number };
}

/** Before upload: a square of at least 400 px is a recommendation, so only a warning (the server fits it into 400×400). */
function checkLogo(file: File, min: number): Promise<string[]> {
  return new Promise((resolve) => {
    const warnings: string[] = [];
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img;
      if (Math.abs(w - h) > Math.max(w, h) * 0.05) warnings.push(`Картинка ${w}×${h} — не квадрат. Логотип впишется в квадрат с прозрачными полями.`);
      if (Math.min(w, h) < min) warnings.push(`Сторона ${Math.min(w, h)} px — меньше рекомендуемых ${min} px, может быть нечётко.`);
      URL.revokeObjectURL(url);
      resolve(warnings);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(warnings);
    };
    img.src = url;
  });
}

/** Админка → Бренды (2.2): logo, address, country, «Почему [бренд] в VITALO», the showcase switch and order. */
export function Brands() {
  const q = useQuery({ queryKey: ['brands', 'admin'], queryFn: () => api<BrandList>('/staff/brands') });
  const [editing, setEditing] = useState<string | null>(null);
  const brand = q.data?.items.find((b) => b.id === editing);
  const [adding, setAdding] = useState(false);
  const { can } = useSession();
  const client = useQueryClient();
  // D-54 «Удалить»: erases the brand everywhere; refused while the shop still has its products
  const remove = useMutation({
    mutationFn: (id: string) => api(`/staff/brands/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['brands'] }),
  });

  return (
    <>
      <PageHead title="Бренды">
        <button className="btn" onClick={() => setAdding(true)}>
          + Добавить бренд
        </button>
      </PageHead>
      <p className="muted">
        Лента «Проверенные бренды» в Mini App показывает включённые бренды, у которых есть товар в наличии.
        Переименование — в «Настройки → Справочники»: название у товаров меняется вместе с ним.
      </p>
      {remove.isError && <p className="alert alert-error">{errorText(remove.error)}</p>}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>Логотип</th>
                <th>Бренд</th>
                <th>Адрес</th>
                <th>Страна</th>
                <th>Товары</th>
                <th>В ленте</th>
                <th>Порядок</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((b) => (
                <tr key={b.id} className={b.status === 'archived' ? 'muted' : ''}>
                  <td>
                    <BrandThumb brand={b} />
                  </td>
                  <td>
                    <strong>{b.name_ru}</strong>
                    {b.why_vitalo_ru || b.why_vitalo_uz ? <div className="muted small">Есть «Почему в VITALO»</div> : null}
                  </td>
                  <td className="small">{b.slug ?? '—'}</td>
                  <td>{b.country_ru ?? '—'}</td>
                  <td>
                    {b.products_in_stock} в наличии <span className="muted small">из {b.products_active}</span>
                  </td>
                  <td>
                    {b.status === 'archived' ? (
                      <Badge>Архив</Badge>
                    ) : b.shown_in_showcase ? (
                      <Badge tone="ok">Показан</Badge>
                    ) : !b.show_in_showcase ? (
                      <Badge>Выключен</Badge>
                    ) : (
                      <Badge tone="warn">Нет в наличии</Badge>
                    )}
                  </td>
                  <td>{b.sort_order}</td>
                  <td>
                    <div className="banner-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing(b.id)}>
                        Изменить
                      </button>
                      {can('catalog.delete') && (
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={remove.isPending}
                          onClick={() =>
                            window.confirm(
                              `Удалить бренд «${b.name_ru}»? Он исчезнет из ленты брендов, акций и баннеров. Отменить нельзя.`,
                            ) && remove.mutate(b.id)
                          }
                        >
                          Удалить
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <NewBrand onClose={() => setAdding(false)} onCreated={(id) => { setAdding(false); setEditing(id); }} />}
      {brand && q.data && <BrandEditor key={brand.id} brand={brand} logoSize={q.data.logo.width} onClose={() => setEditing(null)} />}
    </>
  );
}

/** A new brand goes into the same dictionary as «Настройки → Справочники»; then its card opens for logo and texts. */
function NewBrand({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const client = useQueryClient();
  const [f, setF] = useState({ name_ru: '', name_uz: '' });
  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>('/staff/dictionaries/brands', { method: 'POST', body: { name_ru: f.name_ru.trim(), name_uz: f.name_uz.trim() || null } }),
    onSuccess: async (row) => {
      await client.invalidateQueries({ queryKey: ['brands'] });
      await client.invalidateQueries({ queryKey: dictionaryKey('brands') });
      onCreated(row.id);
    },
  });
  return (
    <Modal title="Новый бренд" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (f.name_ru.trim()) create.mutate();
        }}
      >
        <Field label="Название (RU)">
          <input autoFocus required value={f.name_ru} onChange={(e) => setF({ ...f, name_ru: e.target.value })} placeholder="NOW Foods" />
        </Field>
        <Field label="Название (UZ)" hint="Можно оставить пустым — будет как по-русски">
          <input value={f.name_uz} onChange={(e) => setF({ ...f, name_uz: e.target.value })} />
        </Field>
        {create.isError && <p className="alert alert-error">{errorText(create.error)}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn" disabled={create.isPending || !f.name_ru.trim()}>
            Добавить
          </button>
        </div>
      </form>
    </Modal>
  );
}

function BrandThumb({ brand, size = 40 }: { brand: Pick<Brand, 'name_ru' | 'logo_url'>; size?: number }) {
  return brand.logo_url ? (
    <img className="brand-thumb" src={brand.logo_url} alt="" width={size} height={size} />
  ) : (
    <span className="brand-thumb brand-thumb-empty" style={{ width: size, height: size }}>
      {brand.name_ru.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

function BrandEditor({ brand, logoSize, onClose }: { brand: Brand; logoSize: number; onClose: () => void }) {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: ['brands', 'admin'] });
  const [f, setF] = useState({
    slug: brand.slug ?? '',
    country_ru: brand.country_ru ?? '',
    country_uz: brand.country_uz ?? '',
    why_vitalo_ru: brand.why_vitalo_ru ?? '',
    why_vitalo_uz: brand.why_vitalo_uz ?? '',
    show_in_showcase: brand.show_in_showcase,
    sort_order: String(brand.sort_order),
  });
  const [warnings, setWarnings] = useState<string[]>([]);
  const set = (k: keyof typeof f, v: string | boolean) => setF({ ...f, [k]: v });

  const save = useMutation({
    mutationFn: () =>
      api(`/staff/brands/${brand.id}`, {
        method: 'PATCH',
        body: {
          ...(f.slug.trim() && { slug: f.slug.trim() }),
          country_ru: f.country_ru,
          country_uz: f.country_uz,
          why_vitalo_ru: f.why_vitalo_ru,
          why_vitalo_uz: f.why_vitalo_uz,
          show_in_showcase: f.show_in_showcase,
          sort_order: toInt(f.sort_order) ?? 0,
        },
      }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      setWarnings(await checkLogo(file, logoSize));
      const form = new FormData();
      form.append('file', file);
      return api(`/staff/brands/${brand.id}/logo`, { method: 'POST', form });
    },
    onSuccess: refresh,
  });
  const removeLogo = useMutation({ mutationFn: () => api(`/staff/brands/${brand.id}/logo`, { method: 'DELETE' }), onSuccess: refresh });

  return (
    <Modal title={`Бренд: ${brand.name_ru}`} onClose={onClose} wide>
      <div className="brand-logo-row">
        <BrandThumb brand={brand} size={96} />
        <div>
          <label className="btn btn-ghost btn-sm">
            {brand.logo_url ? 'Заменить логотип' : 'Загрузить логотип'}
            <input
              type="file"
              accept="image/png,image/webp,image/jpeg"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
                e.target.value = '';
              }}
            />
          </label>
          {brand.logo_url && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={removeLogo.isPending} onClick={() => removeLogo.mutate()}>
              Убрать
            </button>
          )}
          <p className="muted small">Квадрат, рекомендуемый размер {logoSize}×{logoSize} px, PNG или WebP (можно с прозрачным фоном).</p>
          {upload.isPending && <p className="muted small">Загружаем…</p>}
          {upload.isError && <p className="alert alert-error">{errorText(upload.error)}</p>}
          {warnings.map((w) => (
            <p key={w} className="alert alert-warn small">
              {w}
            </p>
          ))}
        </div>
      </div>

      <div className="grid-2">
        <Field label="Адрес страницы (slug)" hint={`Страница бренда: /brand/${f.slug || '…'}. Латиница, цифры и «-»`}>
          <input value={f.slug} onChange={(e) => set('slug', e.target.value)} />
        </Field>
        <Field label="Порядок в ленте" hint="Меньше — левее">
          <input inputMode="numeric" value={f.sort_order} onChange={(e) => set('sort_order', e.target.value)} />
        </Field>
        <Field label="Страна (RU)">
          <input value={f.country_ru} onChange={(e) => set('country_ru', e.target.value)} placeholder="США" />
        </Field>
        <Field label="Страна (UZ)">
          <input value={f.country_uz} onChange={(e) => set('country_uz', e.target.value)} placeholder="AQSH" />
        </Field>
        <Field label={`Почему ${brand.name_ru} в VITALO (RU)`} hint="Показывается сверху на странице бренда. Пусто — блока нет">
          <textarea rows={5} value={f.why_vitalo_ru} onChange={(e) => set('why_vitalo_ru', e.target.value)} />
        </Field>
        <Field label={`Почему ${brand.name_ru} в VITALO (UZ)`} hint="Пусто — покупателю на узбекском покажется русский текст">
          <textarea rows={5} value={f.why_vitalo_uz} onChange={(e) => set('why_vitalo_uz', e.target.value)} />
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={f.show_in_showcase} onChange={(e) => set('show_in_showcase', e.target.checked)} />
        Показывать в ленте «Проверенные бренды» (только пока есть товар в наличии)
      </label>

      {save.isError && <p className="alert alert-error">{errorText(save.error)}</p>}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate()}>
          Сохранить
        </button>
      </div>
    </Modal>
  );
}
