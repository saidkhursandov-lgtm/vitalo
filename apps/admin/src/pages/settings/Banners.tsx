import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, ErrorBox, Loading } from '../../components/ui';
import { api } from '../../lib/api';

type Lang = 'ru' | 'uz';
type LinkType = 'product' | 'category' | 'brand';

interface Banner {
  id: string;
  kind: 'doctor' | 'delivery' | 'ai' | 'image';
  enabled: boolean;
  sort_order: number;
  image_ru_url: string | null;
  image_uz_url: string | null;
  link_type: LinkType | null;
  link_value: string | null;
  starts_at: string | null;
  ends_at: string | null;
}
interface BannerList {
  items: Banner[];
  max: number;
  recommended: { width: number; height: number };
}
interface CategoryNode {
  slug: string;
  name_ru: string;
  children?: CategoryNode[];
}

const BUILT_IN: Record<'doctor' | 'delivery' | 'ai', { title: string; text: string }> = {
  ai: { title: 'VITALO AI — «Соберите свой сет в корзине…»', text: 'Тёмно-синий баннер магазина (3.8): «Соберите свой сет в корзине и проверьте совместимость за пару секунд». Нажатие — в каталог.' },
  doctor: { title: '«Отбор врачом • 4,9 ★ на Яндекс Маркете»', text: 'Тёмно-синий баннер магазина. Текст и рисунок встроены.' },
  delivery: {
    title: 'Доставка',
    text: 'Новому клиенту — «Первый заказ — бесплатная доставка», остальным — «Бесплатная доставка от …» (порог из тарифа). Если ни одно не подходит, баннер не показывается.',
  },
};
const MAX_BYTES = 1024 * 1024;
const RATIO = 3;

/** «2026-11-01» from an ISO date (the day in Tashkent), and back: start or end of that day in Tashkent (UTC+5). */
const toDay = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 5 * 3600_000).toISOString().slice(0, 10) : '');
const fromDay = (day: string, end: boolean) => (day ? new Date(`${day}T${end ? '23:59:59' : '00:00:00'}+05:00`).toISOString() : null);

/** Checks the picture before upload: 3:1 and up to 1 MB are recommendations, so only a warning (the server compresses anyway). */
function checkPicture(file: File): Promise<string[]> {
  return new Promise((resolve) => {
    const warnings: string[] = [];
    if (file.size > MAX_BYTES) warnings.push(`Файл ${(file.size / 1024 / 1024).toFixed(1)} МБ — больше 1 МБ. Сервер его сожмёт, но лучше загрузить меньше.`);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const ratio = img.naturalWidth / img.naturalHeight;
      if (Math.abs(ratio - RATIO) > 0.05) {
        warnings.push(`Пропорция ${img.naturalWidth}×${img.naturalHeight} — не 3:1. Края будут обрезаны по центру.`);
      }
      if (img.naturalWidth < 1200) warnings.push(`Ширина ${img.naturalWidth} px — меньше рекомендуемых 1200 px, на телефоне может быть нечётко.`);
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

/** Настройки → Главная → Баннеры (2.1): up to 5, on/off, order, RU / UZ picture, link, dates. */
export function BannersSettings() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'banners'], queryFn: () => api<BannerList>('/staff/settings/banners') });
  const refresh = () => void client.invalidateQueries({ queryKey: ['settings', 'banners'] });
  const add = useMutation({ mutationFn: () => api<Banner>('/staff/settings/banners', { method: 'POST' }), onSuccess: refresh });
  const order = useMutation({
    mutationFn: (ids: string[]) => api<Banner[]>('/staff/settings/banners/order', { method: 'PUT', body: { ids } }),
    onSuccess: refresh,
  });
  const [dragId, setDragId] = useState<string | null>(null);

  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const { items, max, recommended } = q.data;
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const ids = items.map((b) => b.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    order.mutate(ids);
  };

  return (
    <section className="card narrow">
      <div className="section-head">
        <h2>Баннеры на главной</h2>
        <button type="button" className="btn btn-sm" disabled={items.length >= max || add.isPending} onClick={() => add.mutate()}>
          + Добавить баннер
        </button>
      </div>
      <p className="muted small">
        До {max} баннеров, показываются по порядку сверху вниз (порядок — стрелками или перетаскиванием). Если все выключены, блока баннеров на
        главной нет. Картинка: пропорция 3:1, рекомендуемый размер {recommended.width}×{recommended.height} px, JPG/PNG/WebP, до 1 МБ.
      </p>
      {items.length >= max && <div className="alert alert-info">Уже {max} баннеров — это максимум. Чтобы добавить новый, удалите картиночный баннер.</div>}
      <ErrorBox error={add.error ?? order.error} />
      <ol className="banner-list">
        {items.map((b, i) => (
          <li
            key={b.id}
            className={`banner-item ${dragId === b.id ? 'is-dragging' : ''}`}
            draggable
            onDragStart={() => setDragId(b.id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              const from = items.findIndex((x) => x.id === dragId);
              if (from >= 0) move(from, i);
              setDragId(null);
            }}
          >
            <div className="banner-order">
              <span className="banner-grip" aria-hidden title="Перетащите">⋮⋮</span>
              <button type="button" className="btn btn-sm btn-ghost" aria-label="Выше" disabled={i === 0 || order.isPending} onClick={() => move(i, i - 1)}>
                ↑
              </button>
              <button type="button" className="btn btn-sm btn-ghost" aria-label="Ниже" disabled={i === items.length - 1 || order.isPending} onClick={() => move(i, i + 1)}>
                ↓
              </button>
            </div>
            <BannerCard banner={b} index={i} onChanged={refresh} recommended={recommended} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function BannerCard({ banner: b, index, onChanged, recommended }: { banner: Banner; index: number; onChanged: () => void; recommended: BannerList['recommended'] }) {
  const [link, setLink] = useState<{ type: LinkType | ''; value: string }>({ type: b.link_type ?? '', value: b.link_value ?? '' });
  const [days, setDays] = useState({ from: toDay(b.starts_at), to: toDay(b.ends_at) });
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const patch = useMutation({
    mutationFn: (body: object) => api<Banner>(`/staff/settings/banners/${b.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setSaved(true);
      onChanged();
    },
  });
  const image = useMutation({
    mutationFn: ({ lang, file }: { lang: Lang; file: File | null }) => {
      if (!file) return api<Banner>(`/staff/settings/banners/${b.id}/image/${lang}`, { method: 'DELETE' });
      const form = new FormData();
      form.append('file', file);
      return api<Banner>(`/staff/settings/banners/${b.id}/image/${lang}`, { method: 'POST', form });
    },
    onSuccess: onChanged,
  });
  const remove = useMutation({ mutationFn: () => api(`/staff/settings/banners/${b.id}`, { method: 'DELETE' }), onSuccess: onChanged });
  const builtIn = b.kind === 'image' ? null : BUILT_IN[b.kind];
  const hasImage = !!(b.image_ru_url || b.image_uz_url);

  async function pick(lang: Lang, file: File | undefined) {
    if (!file) return;
    setWarnings(await checkPicture(file));
    image.mutate({ lang, file });
  }

  return (
    <div className="banner-card">
      <div className="banner-head">
        <strong>
          {index + 1}. {builtIn ? builtIn.title : 'Картинка'}
        </strong>
        <label className="check">
          <input
            type="checkbox"
            checked={b.enabled}
            disabled={patch.isPending || (b.kind === 'image' && !hasImage && !b.enabled)}
            onChange={(e) => patch.mutate({ enabled: e.target.checked })}
          />
          {b.enabled ? <Badge tone="ok">Включён</Badge> : <Badge>Выключен</Badge>}
        </label>
      </div>
      {builtIn && <p className="muted small">{builtIn.text}</p>}

      {b.kind === 'image' && (
        <>
          {!hasImage && <p className="muted small">Загрузите картинку (RU или UZ) — после этого баннер можно включить.</p>}
          <div className="banner-images">
            {(['ru', 'uz'] as Lang[]).map((lang) => {
              const url = lang === 'ru' ? b.image_ru_url : b.image_uz_url;
              const other = lang === 'ru' ? b.image_uz_url : b.image_ru_url;
              return (
                <div key={lang} className="banner-image">
                  <span className="small strong">Картинка {lang.toUpperCase()}</span>
                  <div className="banner-preview">
                    {url ? <img src={url} alt="" /> : <span className="muted small">{other ? `Нет — покажется картинка ${lang === 'ru' ? 'UZ' : 'RU'}` : 'Нет картинки'}</span>}
                  </div>
                  <div className="banner-image-actions">
                    <label className="btn btn-sm btn-ghost">
                      {url ? 'Заменить' : 'Загрузить'}
                      <input type="file" accept="image/jpeg,image/png,image/webp" hidden disabled={image.isPending} onChange={(e) => void pick(lang, e.target.files?.[0])} />
                    </label>
                    {url && (
                      <button type="button" className="btn btn-sm btn-ghost text-bad" disabled={image.isPending} onClick={() => image.mutate({ lang, file: null })}>
                        Убрать
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="muted small">
            {recommended.width}×{recommended.height} px (3:1), JPG/PNG/WebP, до 1 МБ. На сервере картинка сжимается в WebP. Если загружена только одна, она показывается на обоих языках.
          </p>
          {warnings.map((w) => (
            <div key={w} className="alert alert-warn">
              {w}
            </div>
          ))}
        </>
      )}

      <div className="banner-fields">
        <label className="field">
          <span className="field-label">При нажатии</span>
          <select value={link.type} onChange={(e) => (setLink({ type: e.target.value as LinkType | '', value: '' }), setSaved(false))}>
            <option value="">Ничего</option>
            <option value="product">Открыть товар</option>
            <option value="category">Открыть категорию</option>
            <option value="brand">Открыть бренд</option>
          </select>
        </label>
        {link.type && <LinkTarget type={link.type} value={link.value} onChange={(value) => (setLink({ ...link, value }), setSaved(false))} />}
        <label className="field">
          <span className="field-label">Показывать с</span>
          <input type="date" value={days.from} onChange={(e) => (setDays({ ...days, from: e.target.value }), setSaved(false))} />
        </label>
        <label className="field">
          <span className="field-label">по</span>
          <input type="date" value={days.to} onChange={(e) => (setDays({ ...days, to: e.target.value }), setSaved(false))} />
        </label>
      </div>
      <p className="muted small">Даты необязательны: пусто — показывать всегда. Дата «по» включительно (до конца дня по Ташкенту).</p>
      <ErrorBox error={patch.error ?? image.error ?? remove.error} />
      {saved && <div className="alert alert-ok">Сохранено</div>}
      <div className="banner-actions">
        <button
          type="button"
          className="btn btn-sm"
          disabled={patch.isPending || (!!link.type && !link.value)}
          onClick={() =>
            patch.mutate({
              link_type: link.type || null,
              link_value: link.type ? link.value : null,
              starts_at: fromDay(days.from, false),
              ends_at: fromDay(days.to, true),
            })
          }
        >
          Сохранить ссылку и даты
        </button>
        {b.kind === 'image' && (
          <button type="button" className="btn btn-sm btn-ghost text-bad" disabled={remove.isPending} onClick={() => window.confirm('Удалить этот баннер?') && remove.mutate()}>
            Удалить баннер
          </button>
        )}
      </div>
    </div>
  );
}

/** Product (search by name or SKU), category or brand for the banner link. */
function LinkTarget({ type, value, onChange }: { type: LinkType; value: string; onChange: (v: string) => void }) {
  const [search, setSearch] = useState('');
  const categories = useQuery({
    queryKey: ['categories', 'all'],
    queryFn: () => api<{ need: CategoryNode[]; product_type: CategoryNode[] }>('/catalog/categories?include_empty=true'),
    enabled: type === 'category',
  });
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api<{ brand: string }[]>('/catalog/brands'), enabled: type === 'brand' });
  const products = useQuery({
    queryKey: ['banner-products', search],
    queryFn: () => api<{ items: { id: string; sku: string; name_ru: string }[] }>(`/staff/products?q=${encodeURIComponent(search)}&status=active`),
    enabled: type === 'product',
  });
  const current = useQuery({
    queryKey: ['banner-product', value],
    queryFn: () => api<{ id: string; sku: string; name_ru: string }>(`/staff/products/${value}`),
    enabled: type === 'product' && !!value,
  });

  if (type === 'category') {
    const flat = (nodes: CategoryNode[] = [], depth = 0): { slug: string; label: string }[] =>
      nodes.flatMap((n) => [{ slug: n.slug, label: `${'— '.repeat(depth)}${n.name_ru}` }, ...flat(n.children, depth + 1)]);
    const all = [...flat(categories.data?.need), ...flat(categories.data?.product_type)];
    return (
      <label className="field">
        <span className="field-label">Категория</span>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Выберите…</option>
          {all.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (type === 'brand') {
    return (
      <label className="field">
        <span className="field-label">Бренд</span>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Выберите…</option>
          {brands.data?.map((b) => (
            <option key={b.brand} value={b.brand}>
              {b.brand}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <div className="field">
      <span className="field-label">Товар</span>
      {value && current.data && (
        <p className="small">
          Выбран: <strong>{current.data.name_ru}</strong> ({current.data.sku})
        </p>
      )}
      <input placeholder="Поиск по названию или SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
      <select size={5} value={value} onChange={(e) => onChange(e.target.value)}>
        {products.data?.items.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name_ru} ({p.sku})
          </option>
        ))}
      </select>
    </div>
  );
}
