import { SkuAliases } from './SkuAliases';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DictionarySelect, type DictionaryKind } from '../components/DictionarySelect';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead, toInt } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Competitors } from '../components/Competitors';
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
  ['doctor_verdict', 'Вердикт врача (до 1500 знаков; в карточке видны 4 строки и «Читать полностью»)', 3],
  ['intake_memo', 'Памятка приёма (покупатель увидит с релиза 3)', 3],
] as const;

/** D-53: what a marketer (products.content) may change — the same list as CONTENT_FIELDS in apps/api admin-products.ts */
const CONTENT_FIELDS: string[] = ['name_ru', 'name_uz', 'short_name_ru', 'short_name_uz', 'short_description_ru', 'short_description_uz', 'search_keywords', 'category_ids'];

/** 07.11: the shop's one ИКПУ and package code for Payme — the same as PRODUCT_DEFAULT_* in apps/api payme-config.ts */
const PRODUCT_DEFAULT_IKPU = '02106999028000000';
const PRODUCT_DEFAULT_PACKAGE_CODE = '1490779';

const PLAIN = [
  'sku',
  'name_ru',
  'name_uz',
  'short_name_ru',
  'short_name_uz',
  'search_keywords',
  'substance_form_ru',
  'substance_form_uz',
  'shell_ru',
  'shell_uz',
  'halal_vege_source',
  'halal_vege',
  'admin_note',
  'ikpu_code',
  'package_code',
  'iherb_url',
  'match_form',
] as const;
/** 2.3: numbers of the card; course days = pack / per day. */
const INTS = ['pack_count', 'servings_per_day', 'market_advantage_percent'] as const;
/** 2.3: «Стандарт VITALO» checkboxes */
const STANDARDS = [
  ['std_bioavailability', 'Высокая биодоступность'],
  ['std_tested', 'Проверенный состав'],
  ['std_original', '100% оригинал'],
] as const;
const HALAL_VEGE: [string, string][] = [
  ['', '— не заполнено —'],
  ['halal', 'Halal'],
  ['vege', 'VEGE'],
  ['halal_vege', 'Halal и VEGE'],
  ['none', 'Нет'],
  ['unknown', 'Не знаю'],
];
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
/** Генплан, этап 5 (D-57): «1-в-1» match — the same lists as DOSE_UNITS / DOSE_PER in apps/api iherb-fields.ts */
const DOSE_UNITS: [string, string][] = [
  ['', '—'],
  ['mg', 'мг'],
  ['mcg', 'мкг'],
  ['iu', 'МЕ'],
  ['g', 'г'],
  ['ml', 'мл'],
  ['cfu_bn', 'млрд КОЕ'],
];
const DOSE_PER: [string, string][] = [
  ['', '—'],
  ['capsule', 'на 1 капсулу'],
  ['tablet', 'на 1 таблетку'],
  ['softgel', 'на 1 мягкую капсулу'],
  ['serving', 'на 1 порцию'],
  ['drop', 'на 1 каплю'],
];
/** "18,5" / "18.5" / "" -> number / null */
const toNum = (v: string): number | null => (v.trim() === '' ? null : Number(v.replace(/\s/g, '').replace(',', '.')));
type Form = Record<string, string> & { status: string };

function toForm(p?: AdminProduct): Form {
  const f: Form = { status: (p?.status as string) ?? 'active' };
  for (const k of PLAIN) f[k] = (p?.[k] as string | null) ?? '';
  for (const k of INTS) f[k] = p?.[k] == null ? '' : String(p[k]);
  for (const [k] of STANDARDS) f[k] = p?.[k] ? '1' : '';
  for (const [k] of TEXTS) for (const l of ['ru', 'uz']) f[`${k}_${l}`] = (p?.[`${k}_${l}`] as string | null) ?? '';
  f.price_uzs = p ? String(p.price_uzs) : '';
  f.old_price_uzs = p?.old_price_uzs == null ? '' : String(p.old_price_uzs);
  f.cost_uzs = p?.cost_uzs == null ? '' : String(p.cost_uzs);
  f.min_stock = p ? String(p.min_stock) : '0';
  if (!p) {
    // 07.11: a new product gets the shop's one ИКПУ and package code for Payme (the server does the same when empty)
    f.ikpu_code = PRODUCT_DEFAULT_IKPU;
    f.package_code = PRODUCT_DEFAULT_PACKAGE_CODE;
  }
  for (const [, text] of DICTS) {
    f[text] = (p?.[text] as string | null) ?? '';
    f[`${text}_id`] = (p?.[`${text}_id`] as string | null) ?? '';
  }
  f.yandex_price_uzs = p?.yandex_price_uzs == null ? '' : String(p.yandex_price_uzs);
  for (const [k] of YANDEX_COSTS) f[k] = p?.[k] == null ? '' : String(p[k]);
  // D-57: iHerb and the «1-в-1» match
  f.dose_amount = p?.dose_amount == null ? '' : String(p.dose_amount);
  f.dose_unit = (p?.dose_unit as string | null) ?? '';
  f.dose_per = (p?.dose_per as string | null) ?? '';
  f.cross_border_eligible = p?.cross_border_eligible ? '1' : '';
  f.auto_pricing_enabled = p?.auto_pricing_enabled ? '1' : '';
  f.markup_percent = p?.markup_percent == null ? '80' : String(p.markup_percent);
  f.price_round_to = p?.price_round_to == null ? '1000' : String(p.price_round_to);
  f.stock_price_mode = (p?.stock_price_mode as string | undefined) ?? 'freeze';
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
  // D-53: a marketer changes names, descriptions, search words, categories and photos only
  const contentOnly = !editable && can('products.content');
  const canEdit = (k: string) => editable || (contentOnly && CONTENT_FIELDS.includes(k));
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
      if (contentOnly) {
        const only: Record<string, unknown> = { category_ids: [...cats] };
        for (const k of CONTENT_FIELDS) if (k !== 'category_ids') only[k] = f[k].trim() || (k === 'name_ru' ? f[k] : null);
        return api<AdminProduct>(`/staff/products/${product!.id}`, { method: 'PATCH', body: only });
      }
      const body: Record<string, unknown> = { status: f.status, category_ids: [...cats] };
      for (const k of PLAIN) body[k] = f[k].trim();
      body.halal_vege = f.halal_vege || null;
      for (const k of INTS) body[k] = toInt(f[k]) ?? null;
      for (const [k] of STANDARDS) body[k] = f[k] === '1';
      for (const [, text, , required] of DICTS) {
        body[text] = f[text].trim() || (required ? f[text] : null);
        body[`${text}_id`] = f[`${text}_id`] || null;
      }
      if (yandexView) {
        body.yandex_price_uzs = toInt(f.yandex_price_uzs) ?? null;
        if (alreadyChanged !== undefined) body.yandex_price_already_changed = alreadyChanged;
      }
      if (costsView) for (const [k] of YANDEX_COSTS) body[k] = k === 'yandex_logistics_uzs' ? (toInt(f[k]) ?? null) : toNum(f[k]);
      // D-57: iHerb; the auto pricing settings are admin only (the server refuses them from other roles)
      body.dose_amount = toNum(f.dose_amount);
      body.dose_unit = f.dose_unit || null;
      body.dose_per = f.dose_per || null;
      body.cross_border_eligible = f.cross_border_eligible === '1';
      if (costsView) {
        body.auto_pricing_enabled = f.auto_pricing_enabled === '1';
        body.markup_percent = toInt(f.markup_percent) ?? 80;
        body.price_round_to = toInt(f.price_round_to) ?? 1000;
        body.stock_price_mode = f.stock_price_mode;
      }
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

  // D-54 «Удалить»: erased completely, or — if the product has orders, purchases or stock — archived and hidden
  const remove = useMutation({
    mutationFn: () => api<{ result: 'deleted' | 'archived' }>(`/staff/products/${product!.id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      void client.invalidateQueries({ queryKey: ['products'] });
      if (r.result === 'archived') {
        window.alert('У товара есть история (заказы, закупки или остатки), поэтому его нельзя стереть совсем — история заказов сломается. Товар убран из магазина отовсюду и лежит в архиве.');
      }
      navigate('/products', { replace: true });
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
    <input value={f[k]} disabled={!canEdit(k)} onChange={(e) => set(k, e.target.value)} {...props} />
  );

  const pack = toInt(f.pack_count);
  const perDay = toInt(f.servings_per_day);
  const days = pack && perDay ? Math.floor(pack / perDay) : null;

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
        {can('catalog.delete') && product && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={remove.isPending}
            onClick={() =>
              window.confirm(
                'Удалить товар? Он исчезнет из магазина, корзин, избранного, акций и баннеров. Если по товару были заказы или закупки, он уйдёт в архив, а история сохранится. Отменить нельзя.',
              ) && remove.mutate()
            }
          >
            {remove.isPending ? 'Удаление…' : 'Удалить'}
          </button>
        )}
        {(editable || (contentOnly && product)) && (
          <button type="submit" className="btn" disabled={save.isPending}>
            {save.isPending ? 'Сохранение…' : 'Сохранить'}
          </button>
        )}
      </PageHead>
      {!editable && !contentOnly && <div className="alert alert-info">Только просмотр: менять товары может администратор.</div>}
      {contentOnly && <div className="alert alert-info">Вы можете менять названия, краткое описание, слова для поиска, категории и фото. Цены, состав и остальное меняет администратор.</div>}
      {f.status === 'archived' && <div className="alert alert-warn">Товар в архиве: он не виден в магазине.</div>}
      {product?.admin_note ? <div className="alert alert-warn">Комментарий: {product.admin_note as string}</div> : null}
      {saved && <div className="alert alert-ok">Сохранено</div>}
      <ErrorBox error={save.error ?? archive.error ?? remove.error ?? markSynced.error} />
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
            <Field label="Короткое название (RU)" hint="Для корзины, оформления и заказов, до 60 знаков. Если пусто — полное">
              {input('short_name_ru', { maxLength: 60, placeholder: 'Например: Витамин D3, 60 капсул' })}
            </Field>
            <Field label="Короткое название (UZ)" hint="Если пусто — полное узбекское">
              {input('short_name_uz', { maxLength: 60, placeholder: 'Masalan: Vitamin D3, 60 kapsula' })}
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

      <section className="card">
        <div className="section-head">
          <h2>Чек для Payme</h2>
          {product && (product.ikpu_code && product.package_code ? <Badge tone="ok">Заполнено</Badge> : <Badge tone="warn">Без кодов Payme недоступен</Badge>)}
        </div>
        <p className="muted small">
          Payme отправляет чек в налоговую, поэтому у товара должны быть ИКПУ и код упаковки (каталог tasnif.soliq.uz). Если в заказе
          есть товар без них, покупатель не сможет выбрать Payme — останутся другие способы оплаты.
        </p>
        <div className="form-grid">
          <Field label="ИКПУ (MXIK)" hint="Ровно 17 цифр">
            {input('ikpu_code', { inputMode: 'numeric', maxLength: 17, pattern: '\\d{17}', placeholder: '03004001001000000' })}
          </Field>
          <Field label="Код упаковки" hint="Из карточки ИКПУ на tasnif.soliq.uz, только цифры">
            {input('package_code', { inputMode: 'numeric', maxLength: 20, pattern: '\\d{1,20}' })}
          </Field>
        </div>
      </section>

      <IherbCard f={f} set={set} input={input} editable={editable} costsView={costsView} price={toInt(f.price_uzs)} />

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
        {/* 2.2: one level; several needs, exactly one type (the server checks it too) */}
        {categories.data && (
          <div className="grid-2">
            <div className="check-col">
              <h3>По потребности</h3>
              <p className="muted small">Можно несколько</p>
              {categories.data.need.map((n) => (
                <label key={n.id} className="check">
                  <input
                    type="checkbox"
                    checked={cats.has(n.id)}
                    disabled={!canEdit('category_ids')}
                    onChange={() => {
                      const next = new Set(cats);
                      if (next.has(n.id)) next.delete(n.id);
                      else next.add(n.id);
                      setCats(next);
                      setSaved(false);
                    }}
                  />
                  {n.name_ru}
                </label>
              ))}
            </div>
            <div className="check-col">
              <h3>По типу</h3>
              <p className="muted small">Один тип на товар</p>
              {categories.data.product_type.map((n) => (
                <label key={n.id} className="check">
                  <input
                    type="radio"
                    name="product_type"
                    checked={cats.has(n.id)}
                    disabled={!canEdit('category_ids')}
                    onChange={() => {
                      const types = new Set(categories.data.product_type.map((c) => c.id));
                      setCats(new Set([...cats].filter((id) => !types.has(id)).concat(n.id)));
                      setSaved(false);
                    }}
                  />
                  {n.name_ru}
                </label>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Карточка в магазине: экспертиза</h2>
        <p className="muted small">Пустые поля покупатель не видит — блок просто не показывается.</p>
        <div className="form-grid">
          <Field label="Форма вещества (RU)" hint="Под названием: «Цитрат + B6»">
            {input('substance_form_ru', { maxLength: 60, placeholder: 'Например: Цитрат + B6' })}
          </Field>
          <Field label="Форма вещества (UZ)">{input('substance_form_uz', { maxLength: 60, placeholder: 'Masalan: Sitrat + B6' })}</Field>
          <Field label="Количество в банке" hint="Капсул / таблеток / порций">
            {input('pack_count', { inputMode: 'numeric' })}
          </Field>
          <Field
            label="Порций в день"
            hint={days ? (days >= 7 ? `Хватит на ${days} дн.` : `${days} дн. — меньше 7, «Хватит на…» не покажется`) : 'По этикетке'}
          >
            {input('servings_per_day', { inputMode: 'numeric' })}
          </Field>
          <Field label="Выгоднее Маркета, %" hint="0–50, только если правда. Пусто — плашки нет">
            {input('market_advantage_percent', { inputMode: 'numeric' })}
          </Field>
          <Field label="Halal / VEGE" hint="Halal — только с сертификатом, VEGE — только по этикетке (D-32)">
            <select value={f.halal_vege} disabled={!editable} onChange={(e) => set('halal_vege', e.target.value)}>
              {HALAL_VEGE.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Оболочка (RU)" hint="Строка «Оболочка: …»">{input('shell_ru', { maxLength: 100, placeholder: 'Например: говяжий желатин' })}</Field>
          <Field label="Оболочка (UZ)">{input('shell_uz', { maxLength: 100, placeholder: 'Masalan: mol jelatini' })}</Field>
          <Field label="Откуда данные Halal / VEGE" hint="Видно только в админке">
            {input('halal_vege_source', { maxLength: 300 })}
          </Field>
        </div>
        <div className="check-col">
          <h3>Стандарт VITALO</h3>
          {STANDARDS.map(([k, label]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={f[k] === '1'} disabled={!editable} onChange={(e) => set(k, e.target.checked ? '1' : '')} />
              {label}
            </label>
          ))}
        </div>
        <Field label="Комментарий сотрудникам" hint="Покупатель не видит. Например: «сверить при следующей поставке»">
          <textarea rows={2} maxLength={1000} value={f.admin_note} disabled={!editable} onChange={(e) => set('admin_note', e.target.value)} />
        </Field>
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
            <textarea rows={rows} value={f[`${k}_${lang}`]} disabled={!canEdit(`${k}_${lang}`)} onChange={(e) => set(`${k}_${lang}`, e.target.value)} />
          </Field>
        ))}
      </section>

    </form>
    {/* Own forms and buttons: outside the product form, so their submit never saves the whole product too. */}
    {product && <LabelCard product={product} />}
    {/* D-57 узел 4: competitor prices with the «1-в-1» match — admin only */}
    {product && can('competitors.manage') && <Competitors productId={product.id} />}
    {product && <SkuAliases productId={product.id} sku={product.sku} />}
    {product ? <Photos product={product} editable={editable || contentOnly} /> : <p className="muted">Фото можно добавить после первого сохранения.</p>}
    </>
  );
}

/**
 * Stage 2B: short composition RU / UZ (admin and manager); unit tracking is shown only. The Physical ID label 58×40
 * does not print it: the field stays for the 75×120 template (a future courier-bag label).
 */
/**
 * Генплан, этап 5 (D-57, docs/plans/IHERB_PLAN.md): the iHerb link, «Под заказ из США», auto pricing (admin only) and
 * the «1-в-1» match fields (brand + chemical form + dose + pack count). Prices from iHerb come in the next branch.
 */
function IherbCard({
  f,
  set,
  input,
  editable,
  costsView,
  price,
}: {
  f: Form;
  set: (k: string, v: string) => void;
  input: (k: string, props?: Record<string, unknown>) => ReactNode;
  editable: boolean;
  costsView: boolean;
  price: number | undefined;
}) {
  const markup = toInt(f.markup_percent) ?? 80;
  const round = Math.max(1, toInt(f.price_round_to) ?? 1000);
  const example = 100_000;
  const exampleOut = Math.ceil((example * (1 + markup / 100)) / round) * round;
  return (
    <section className="card">
      <div className="section-head">
        <h2>iHerb и сверка «1-в-1»</h2>
        {f.iherb_url ? <Badge tone="info">iHerb</Badge> : null}
      </div>
      <div className="form-grid">
        <Field label="Ссылка на товар iHerb" hint="Страница товара, например https://uz.iherb.com/pr/…/12345">
          {input('iherb_url', { type: 'url', maxLength: 500, placeholder: 'https://uz.iherb.com/pr/…' })}
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.cross_border_eligible === '1'} disabled={!editable} onChange={(e) => set('cross_border_eligible', e.target.checked ? '1' : '')} />
          <span>
            «Под заказ из США», когда на складе ноль
            <span className="muted small"> — покупатели увидят после ответа юриста и включения функции</span>
          </span>
        </label>
      </div>
      {costsView && (
        <>
          <h3>Автоцена (видно только администратору)</h3>
          <div className="form-grid">
            <label className="check">
              <input type="checkbox" checked={f.auto_pricing_enabled === '1'} disabled={!editable} onChange={(e) => set('auto_pricing_enabled', e.target.checked ? '1' : '')} />
              <span>Цена = цена iHerb + наценка (заработает, когда появятся цены iHerb)</span>
            </label>
            <Field label="Наценка, %" hint={`Пример: iHerb 100 000 сум → ${exampleOut.toLocaleString('ru-RU')} сум`}>
              {input('markup_percent', { inputMode: 'numeric' })}
            </Field>
            <Field label="Округлять вверх до, сум" hint="1000 — до тысячи">
              {input('price_round_to', { inputMode: 'numeric' })}
            </Field>
            <Field label="Если товар есть на складе" hint="Цена всё равно не опустится ниже себестоимости с минимальной маржой">
              <select value={f.stock_price_mode} disabled={!editable} onChange={(e) => set('stock_price_mode', e.target.value)}>
                <option value="freeze">Цену не менять</option>
                <option value="dynamic">Менять вместе с iHerb</option>
              </select>
            </Field>
          </div>
          {price !== undefined && <p className="muted small">Сейчас цена VITALO: {price.toLocaleString('ru-RU')} сум.</p>}
        </>
      )}
      <h3>Сверка с конкурентами</h3>
      <p className="muted small">
        Цена конкурента сравнивается, только если совпадают все четыре: бренд, химическая форма, доза и количество в банке
        (бренд и количество — в разделах выше).
      </p>
      <div className="form-grid">
        <Field label="Химическая форма" hint="Например: бисглицинат, цитрат, D3 холекальциферол">
          {input('match_form', { maxLength: 80 })}
        </Field>
        <Field label="Доза">{input('dose_amount', { inputMode: 'decimal', placeholder: 'например 25' })}</Field>
        <Field label="Единица">
          <select value={f.dose_unit} disabled={!editable} onChange={(e) => set('dose_unit', e.target.value)}>
            {DOSE_UNITS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="На что">
          <select value={f.dose_per} disabled={!editable} onChange={(e) => set('dose_per', e.target.value)}>
            {DOSE_PER.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </section>
  );
}

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
