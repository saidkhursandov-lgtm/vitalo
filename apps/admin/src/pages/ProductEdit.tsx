import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, ErrorBox, Field, Loading, PageHead, toInt } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { PRODUCT_STATUS } from '../lib/format';
import { BackIcon } from '../components/Icons';

interface CategoryNode {
  id: string;
  name_ru: string;
  children: CategoryNode[];
}

interface AdminProduct {
  id: string;
  sku: string;
  status: string;
  price_uzs: number;
  old_price_uzs: number | null;
  cost_uzs: number | null;
  min_stock: number;
  category_ids: string[];
  media: { id: string; url: string; is_main: boolean; type: string }[];
  stock: { warehouse: { name: string }; actual_qty: number; reserved_qty: number; available_qty: number }[];
  [text: string]: unknown;
}

const TEXTS = [
  ['short_description', 'Краткое описание', 3],
  ['composition', 'Состав', 4],
  ['nutrition', 'Пищевая ценность / дозировка', 3],
  ['directions', 'Способ применения', 3],
  ['warnings', 'Противопоказания и предупреждения', 3],
] as const;

const PLAIN = ['sku', 'name_ru', 'name_uz', 'brand', 'manufacturer', 'country', 'form', 'search_keywords'] as const;
type Form = Record<string, string> & { status: string };

function toForm(p?: AdminProduct): Form {
  const f: Form = { status: (p?.status as string) ?? 'active' };
  for (const k of PLAIN) f[k] = (p?.[k] as string | null) ?? '';
  for (const [k] of TEXTS) for (const l of ['ru', 'uz']) f[`${k}_${l}`] = (p?.[`${k}_${l}`] as string | null) ?? '';
  f.price_uzs = p ? String(p.price_uzs) : '';
  f.old_price_uzs = p?.old_price_uzs == null ? '' : String(p.old_price_uzs);
  f.cost_uzs = p?.cost_uzs == null ? '' : String(p.cost_uzs);
  f.min_stock = p ? String(p.min_stock) : '0';
  return f;
}

/** Create (/products/new) or edit a product. Read-only for roles without products.edit. */
export function ProductEdit() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const q = useQuery({ queryKey: ['product', id], queryFn: () => api<AdminProduct>(`/staff/products/${id}`), enabled: !isNew });
  if (!isNew && q.isPending) return <Loading />;
  if (!isNew && q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  return <ProductForm key={id} product={isNew ? undefined : q.data} />;
}

function ProductForm({ product }: { product?: AdminProduct }) {
  const { can } = useSession();
  const editable = can('products.edit');
  const navigate = useNavigate();
  const client = useQueryClient();
  const categories = useQuery({ queryKey: ['categories', 'all'], queryFn: () => api<{ need: CategoryNode[]; product_type: CategoryNode[] }>('/catalog/categories?include_empty=true') });
  const [f, setF] = useState<Form>(() => toForm(product));
  const [cats, setCats] = useState<Set<string>>(new Set(product?.category_ids ?? []));
  const [lang, setLang] = useState<'ru' | 'uz'>('ru');
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { status: f.status, category_ids: [...cats] };
      for (const k of PLAIN) body[k] = f[k].trim();
      for (const [k] of TEXTS) for (const l of ['ru', 'uz']) body[`${k}_${l}`] = f[`${k}_${l}`];
      body.price_uzs = toInt(f.price_uzs);
      body.old_price_uzs = toInt(f.old_price_uzs) ?? null;
      if (can('costs.view')) body.cost_uzs = toInt(f.cost_uzs) ?? null; // the server refuses it from other roles
      body.min_stock = toInt(f.min_stock) ?? 0;
      return product
        ? api<AdminProduct>(`/staff/products/${product.id}`, { method: 'PATCH', body })
        : api<AdminProduct>('/staff/products', { method: 'POST', body });
    },
    onSuccess: (p) => {
      client.setQueryData(['product', p.id], p);
      void client.invalidateQueries({ queryKey: ['products'] });
      setSaved(true);
      if (!product) navigate(`/products/${p.id}`, { replace: true });
    },
  });

  const archive = useMutation({
    mutationFn: () => api<AdminProduct>(`/staff/products/${product!.id}/archive`, { method: 'POST' }),
    onSuccess: (p) => {
      client.setQueryData(['product', p.id], p);
      void client.invalidateQueries({ queryKey: ['products'] });
      setF((x) => ({ ...x, status: p.status }));
      setSaved(true);
    },
  });

  const set = (k: string, v: string) => {
    setF({ ...f, [k]: v });
    setSaved(false);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const input = (k: string, props: Record<string, unknown> = {}) => (
    <input value={f[k]} disabled={!editable} onChange={(e) => set(k, e.target.value)} {...props} />
  );

  return (
    <form onSubmit={submit}>
      <PageHead title={product ? `Товар: ${product.name_ru as string}` : 'Новый товар'}>
        <Link to="/products" className="btn btn-ghost">
          <BackIcon /> К списку
        </Link>
        {editable && product && product.status !== 'archived' && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={archive.isPending}
            onClick={() => window.confirm('Убрать товар в архив? Он перестанет показываться в магазине.') && archive.mutate()}
          >
            В архив
          </button>
        )}
        {editable && (
          <button type="submit" className="btn" disabled={save.isPending}>
            {save.isPending ? 'Сохранение…' : 'Сохранить'}
          </button>
        )}
      </PageHead>
      {!editable && <div className="alert alert-info">Только просмотр: менять товары может администратор.</div>}
      {f.status === 'archived' && <div className="alert alert-warn">Товар в архиве: он не виден в магазине. Удалять товары нельзя — только архивировать.</div>}
      {saved && <div className="alert alert-ok">Сохранено</div>}
      <ErrorBox error={save.error ?? archive.error} />

      <div className="grid-2">
        <section className="card">
          <h2>Основное</h2>
          <div className="form-grid">
            <Field label="SKU">{input('sku', { required: true })}</Field>
            <Field label="Статус">
              <select value={f.status} disabled={!editable} onChange={(e) => set('status', e.target.value)}>
                {Object.entries(PRODUCT_STATUS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Название (RU)">{input('name_ru', { required: true })}</Field>
            <Field label="Название (UZ)" hint="Если пусто — в магазине покажется русское">
              {input('name_uz')}
            </Field>
            <Field label="Бренд">{input('brand', { required: true })}</Field>
            <Field label="Производитель">{input('manufacturer', { required: true })}</Field>
            <Field label="Страна">{input('country')}</Field>
            <Field label="Форма выпуска" hint="Капсулы, Таблетки, Порошок…">
              {input('form')}
            </Field>
          </div>
          <Field label="Ключевые слова для поиска" hint="Через пробел, можно латиницей: collagen, omega">
            {input('search_keywords')}
          </Field>
        </section>

        <section className="card">
          <h2>Цены и остатки</h2>
          <div className="form-grid">
            <Field label="Цена, сум">{input('price_uzs', { inputMode: 'numeric', required: true })}</Field>
            <Field label="Старая цена, сум" hint="Для показа скидки">
              {input('old_price_uzs', { inputMode: 'numeric' })}
            </Field>
            {can('costs.view') && (
              <Field label="Себестоимость, сум" hint="Видна только администратору">
                {input('cost_uzs', { inputMode: 'numeric' })}
              </Field>
            )}
            <Field label="Минимальный остаток" hint="Ниже — в «Низких остатках»">
              {input('min_stock', { inputMode: 'numeric' })}
            </Field>
          </div>
          {product && (
            <table className="table">
              <thead>
                <tr>
                  <th>Склад</th>
                  <th className="num">Всего</th>
                  <th className="num">В резерве</th>
                  <th className="num">Доступно</th>
                </tr>
              </thead>
              <tbody>
                {product.stock.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      Остатков нет — оформите приход в разделе «Склад»
                    </td>
                  </tr>
                )}
                {product.stock.map((s) => (
                  <tr key={s.warehouse.name}>
                    <td>{s.warehouse.name}</td>
                    <td className="num">{s.actual_qty}</td>
                    <td className="num">{s.reserved_qty}</td>
                    <td className="num">{s.available_qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Категории</h2>
        {categories.data && (
          <div className="grid-2">
            {(['need', 'product_type'] as const).map((tree) => (
              <div key={tree}>
                <h3>{tree === 'need' ? 'По потребности' : 'По типу продукта'}</h3>
                <CategoryChecks nodes={categories.data[tree]} selected={cats} disabled={!editable} onToggle={(cid) => {
                  const next = new Set(cats);
                  if (next.has(cid)) next.delete(cid);
                  else next.add(cid);
                  setCats(next);
                  setSaved(false);
                }} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-head">
          <h2>Тексты карточки</h2>
          <div className="segmented">
            <button type="button" className={lang === 'ru' ? 'is-on' : ''} onClick={() => setLang('ru')}>
              Русский
            </button>
            <button type="button" className={lang === 'uz' ? 'is-on' : ''} onClick={() => setLang('uz')}>
              O‘zbekcha
            </button>
          </div>
        </div>
        {TEXTS.map(([k, label, rows]) => (
          <Field key={`${k}_${lang}`} label={`${label} (${lang.toUpperCase()})`}>
            <textarea rows={rows} value={f[`${k}_${lang}`]} disabled={!editable} onChange={(e) => set(`${k}_${lang}`, e.target.value)} />
          </Field>
        ))}
      </section>

      {product ? <Photos product={product} editable={editable} /> : <p className="muted">Фото можно добавить после первого сохранения.</p>}
    </form>
  );
}

function CategoryChecks({ nodes, selected, disabled, onToggle, depth = 0 }: { nodes: CategoryNode[]; selected: Set<string>; disabled: boolean; onToggle: (id: string) => void; depth?: number }) {
  return (
    <>
      {nodes.map((n) => (
        <div key={n.id}>
          <label className="check" style={{ paddingLeft: depth * 20 }}>
            <input type="checkbox" checked={selected.has(n.id)} disabled={disabled} onChange={() => onToggle(n.id)} />
            {n.name_ru}
          </label>
          <CategoryChecks nodes={n.children} selected={selected} disabled={disabled} onToggle={onToggle} depth={depth + 1} />
        </div>
      ))}
    </>
  );
}

/** Photo upload goes through the API's FileStorage (local folder now, S3 later) — the UI does not care. */
function Photos({ product, editable }: { product: AdminProduct; editable: boolean }) {
  const client = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const done = (p: AdminProduct) => {
    client.setQueryData(['product', p.id], p);
    void client.invalidateQueries({ queryKey: ['products'] });
  };
  const upload = useMutation({
    mutationFn: async (files: FileList) => {
      let last: AdminProduct = product;
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append('file', file);
        last = await api<AdminProduct>(`/staff/products/${product.id}/photos`, { method: 'POST', form });
      }
      return last;
    },
    onSuccess: done,
    onSettled: () => fileRef.current && (fileRef.current.value = ''),
  });
  const action = useMutation({
    mutationFn: ({ mediaId, kind }: { mediaId: string; kind: 'main' | 'delete' }) =>
      kind === 'main'
        ? api<AdminProduct>(`/staff/products/${product.id}/photos/${mediaId}/main`, { method: 'POST' })
        : api<AdminProduct>(`/staff/products/${product.id}/photos/${mediaId}`, { method: 'DELETE' }),
    onSuccess: done,
  });
  const images = product.media.filter((m) => m.type === 'image');

  return (
    <section className="card">
      <div className="section-head">
        <h2>Фото</h2>
        {editable && (
          <label className="btn btn-ghost">
            {upload.isPending ? 'Загрузка…' : '+ Загрузить фото'}
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              hidden
              onChange={(e) => e.target.files?.length && upload.mutate(e.target.files)}
            />
          </label>
        )}
      </div>
      <p className="muted small">JPEG, PNG или WebP до 5 МБ. Главное фото показывается в каталоге.</p>
      <ErrorBox error={upload.error ?? action.error} />
      <div className="photos">
        {images.length === 0 && <p className="muted">Фото пока нет</p>}
        {images.map((m) => (
          <div key={m.id} className={`photo ${m.is_main ? 'is-main' : ''}`}>
            <img src={m.url} alt="" />
            <div className="photo-bar">
              {m.is_main ? (
                <Badge tone="ok">Главное</Badge>
              ) : (
                editable && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => action.mutate({ mediaId: m.id, kind: 'main' })}>
                    Сделать главным
                  </button>
                )
              )}
              {editable && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost text-bad"
                  onClick={() => window.confirm('Удалить это фото?') && action.mutate({ mediaId: m.id, kind: 'delete' })}
                >
                  Удалить
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
