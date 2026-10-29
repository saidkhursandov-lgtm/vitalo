import { SkuAliases } from './SkuAliases';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DictionarySelect, type DictionaryKind } from '../components/DictionarySelect';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead, toInt } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { dateTime, discountAboveLimit, MAX_SHOWN_DISCOUNT, PRODUCT_STATUS } from '../lib/format';
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
  cost_uzs?: number | null;
  min_stock: number;
  // Yandex Market: price for admin / manager / marketer; commission, fee, logistics for admin only (absent otherwise)
  yandex_price_uzs?: number | null;
  yandex_price_sync_needed?: boolean;
  yandex_price_sync_changed_at?: string | null;
  yandex_commission_percent?: number | null;
  yandex_payment_fee_percent?: number | null;
  yandex_logistics_uzs?: number | null;
  category_ids: string[];
  media: { id: string; url: string; is_main: boolean; type: string }[];
  stock: { warehouse: { name: string }; actual_qty: number; reserved_qty: number; available_qty: number }[];
  // Stage 2B
  unit_tracking?: boolean;
  label_composition_ru?: string | null;
  label_composition_uz?: string | null;
  [text: string]: unknown;
}

const TEXTS = [
  ['short_description', 'Краткое описание', 3],
  ['composition', 'Состав', 4],
  ['nutrition', 'Пищевая ценность / дозировка', 3],
  ['directions', 'Способ применения', 3],
  ['warnings', 'Противопоказания и предупреждения', 3],
] as const;

const PLAIN = ['sku', 'name_ru', 'name_uz', 'search_keywords'] as const;
/** Dictionary fields: the text column the shop shows + the dictionary link. */
const DICTS: [DictionaryKind, string, string, boolean][] = [
  ['brands', 'brand', 'Бренд', true],
  ['manufacturers', 'manufacturer', 'Производитель', true],
  ['countries', 'country', 'Страна', false],
  ['forms', 'form', 'Форма выпуска', false],
];
const YANDEX_COSTS = [
  ['yandex_commission_percent', 'Комиссия Яндекса, %'],
  ['yandex_payment_fee_percent', 'Платёжный сбор Яндекса, %'],
  ['yandex_logistics_uzs', 'Логистика Яндекса за заказ, сум'],
] as const;
/** "18,5" / "18.5" / "" -> number / null */
const toNum = (v: string): number | null => (v.trim() === '' ? null : Number(v.replace(/\s/g, '').replace(',', '.')));
type Form = Record<string, string> & { status: string };

function toForm(p?: AdminProduct): Form {
  const f: Form = { status: (p?.status as string) ?? 'active' };
  for (const k of PLAIN) f[k] = (p?.[k] as string | null) ?? '';
  for (const [k] of TEXTS) for (const l of ['ru', 'uz']) f[`${k}_${l}`] = (p?.[`${k}_${l}`] as string | null) ?? '';
  f.price_uzs = p ? String(p.price_uzs) : '';
  f.old_price_uzs = p?.old_price_uzs == null ? '' : String(p.old_price_uzs);
  f.cost_uzs = p?.cost_uzs == null ? '' : String(p.cost_uzs);
  f.min_stock = p ? String(p.min_stock) : '0';
  for (const [, text] of DICTS) {
    f[text] = (p?.[text] as string | null) ?? '';
    f[`${text}_id`] = (p?.[`${text}_id`] as string | null) ?? '';
  }
  f.yandex_price_uzs = p?.yandex_price_uzs == null ? '' : String(p.yandex_price_uzs);
  for (const [k] of YANDEX_COSTS) f[k] = p?.[k] == null ? '' : String(p[k]);
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
  const [askSync, setAskSync] = useState(false);
  const yandexView = can('yandex.price.view');
  const costsView = can('costs.view');

  const save = useMutation({
    /** alreadyChanged: answer to «Вы уже изменили цену в Яндекс Маркете?» (only when the Yandex price changes) */
    mutationFn: (alreadyChanged?: boolean) => {
      const body: Record<string, unknown> = { status: f.status, category_ids: [...cats] };
      for (const k of PLAIN) body[k] = f[k].trim();
      for (const [, text, , required] of DICTS) {
        body[text] = f[text].trim() || (required ? f[text] : null);
        body[`${text}_id`] = f[`${text}_id`] || null;
      }
      if (yandexView) {
        body.yandex_price_uzs = toInt(f.yandex_price_uzs) ?? null;
        if (alreadyChanged !== undefined) body.yandex_price_already_changed = alreadyChanged;
      }
      if (costsView) for (const [k] of YANDEX_COSTS) body[k] = k === 'yandex_logistics_uzs' ? (toInt(f[k]) ?? null) : toNum(f[k]);
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
      setF((x) => ({ ...x, yandex_price_uzs: p.yandex_price_uzs == null ? '' : String(p.yandex_price_uzs) }));
      if (!product) navigate(`/products/${p.id}`, { replace: true });
    },
  });

  const markSynced = useMutation({
    mutationFn: () => api<AdminProduct>(`/staff/products/${product!.id}/yandex-price-synced`, { method: 'POST' }),
    onSuccess: (p) => {
      client.setQueryData(['product', p.id], p);
      void client.invalidateQueries({ queryKey: ['products'] });
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
  /** The VITALO price is applied in the shop at once; only a changed Yandex price asks about Yandex Market. */
  // D-09: a discount above 25% is not shown to customers; saving is still allowed
  const bigDiscount = discountAboveLimit(toInt(f.price_uzs), toInt(f.old_price_uzs));
  const yandexPriceChanged = yandexView && (toInt(f.yandex_price_uzs) ?? null) !== (product?.yandex_price_uzs ?? null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (yandexPriceChanged) setAskSync(true);
    else save.mutate(undefined);
  };
  const answer = (alreadyChanged: boolean) => {
    setAskSync(false);
    save.mutate(alreadyChanged);
  };
  const input = (k: string, props: Record<string, unknown> = {}) => (
    <input value={f[k]} disabled={!editable} onChange={(e) => set(k, e.target.value)} {...props} />
  );

  return (
    <>
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
      <ErrorBox error={save.error ?? archive.error ?? markSynced.error} />
      {askSync && (
        <Modal title="Цена на Яндекс Маркете" onClose={() => setAskSync(false)}>
          <p>
            Цена Яндекса меняется: {product?.yandex_price_uzs ?? '—'} → {f.yandex_price_uzs || '—'} сум.
            <br />
            <strong>Вы уже изменили цену в Яндекс Маркете?</strong>
          </p>
          <div className="page-actions">
            <button type="button" className="btn" onClick={() => answer(true)}>
              Да, уже изменил(а)
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => answer(false)}>
              Нет — отметить «требует синхронизации»
            </button>
          </div>
        </Modal>
      )}

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
            {DICTS.map(([kind, text, label, required]) => (
              <Field key={kind} label={label}>
                <DictionarySelect
                  kind={kind}
                  valueId={f[`${text}_id`]}
                  text={f[text]}
                  required={required}
                  disabled={!editable}
                  onChange={(v) => {
                    setF((x) => ({ ...x, [text]: v.name, [`${text}_id`]: v.id }));
                    setSaved(false);
                  }}
                />
              </Field>
            ))}
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
          {bigDiscount !== null && (
            <div className="alert alert-warn">
              Скидка {bigDiscount}% больше {MAX_SHOWN_DISCOUNT}%: в магазине зачёркнутая цена и процент для этого товара показываться не будут. Сохранить можно.
            </div>
          )}
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

      {yandexView && (
        <section className="card">
          <div className="section-head">
            <h2>Яндекс Маркет</h2>
            {product?.yandex_price_sync_needed ? (
              <Badge tone="warn">Цена Яндекса требует синхронизации</Badge>
            ) : product?.yandex_price_uzs != null ? (
              <Badge tone="ok">Синхронизирована</Badge>
            ) : null}
          </div>
          <div className="form-grid">
            <Field label="Цена на Яндексе, сум" hint="Цена VITALO (выше) применяется в магазине сразу; про цену Яндекса спросим при сохранении">
              {input('yandex_price_uzs', { inputMode: 'numeric' })}
            </Field>
            {costsView &&
              YANDEX_COSTS.map(([k, label]) => (
                <Field key={k} label={label} hint="Видно только администратору">
                  {input(k, { inputMode: 'decimal' })}
                </Field>
              ))}
          </div>
          {product?.yandex_price_sync_changed_at && <p className="muted small">Цена Яндекса менялась: {dateTime(product.yandex_price_sync_changed_at)}</p>}
          {product?.yandex_price_sync_needed && can('yandex.price.sync') && (
            <button type="button" className="btn btn-ghost" disabled={markSynced.isPending} onClick={() => markSynced.mutate()}>
              Отметить синхронизированной
            </button>
          )}
        </section>
      )}

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

    </form>
    {/* Own forms and buttons: outside the product form, so their submit never saves the whole product too. */}
    {product && <LabelCard product={product} />}
    {product && <SkuAliases productId={product.id} sku={product.sku} />}
    {product ? <Photos product={product} editable={editable} /> : <p className="muted">Фото можно добавить после первого сохранения.</p>}
    </>
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

/**
 * Stage 2B: short composition RU / UZ (admin and manager); unit tracking is shown only. The Physical ID label 58×40
 * does not print it: the field stays for the 75×120 template (a future courier-bag label).
 */
function LabelCard({ product }: { product: AdminProduct }) {
  const { can } = useSession();
  const editable = can('products.label');
  const client = useQueryClient();
  const [ru, setRu] = useState(product.label_composition_ru ?? '');
  const [uz, setUz] = useState(product.label_composition_uz ?? '');
  const [saved, setSaved] = useState(false);
  const m = useMutation({
    mutationFn: () => api<AdminProduct>(`/staff/products/${product.id}/label`, { method: 'PATCH', body: { label_composition_ru: ru, label_composition_uz: uz } }),
    onSuccess: (p) => {
      client.setQueryData(['product', p.id], p);
      setSaved(true);
    },
  });
  return (
    <section className="card">
      <div className="section-head">
        <h2>Короткий состав</h2>
        <span>
          Учёт по единицам: {product.unit_tracking ? <Badge tone="info">да</Badge> : <Badge>нет</Badge>}
        </span>
      </div>
      <p className="muted small">На этикетку Physical ID (58×40) состав не печатается. Заполнять не обязательно.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          m.mutate();
        }}
      >
        <div className="form-grid">
          <Field label="Короткий состав для этикетки (RU)" hint={`До 300 символов, сейчас ${ru.length}. Полный состав — в «Тексты карточки».`}>
            <textarea rows={3} maxLength={300} value={ru} disabled={!editable} onChange={(e) => setRu(e.target.value)} />
          </Field>
          <Field label="Короткий состав для этикетки (UZ)" hint={`Tarkibi, до 300 символов, сейчас ${uz.length}. Буквы o‘ и g‘ печатаются.`}>
            <textarea rows={3} maxLength={300} value={uz} disabled={!editable} onChange={(e) => setUz(e.target.value)} />
          </Field>
        </div>
        <ErrorBox error={m.error} />
        {saved && <div className="alert alert-ok">Состав для этикетки сохранён</div>}
        {editable && (
          <button className="btn" disabled={m.isPending}>
            Сохранить состав для этикетки
          </button>
        )}
      </form>
    </section>
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
