import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge, ErrorBox, Loading } from '../../components/ui';
import { api } from '../../lib/api';
import { money } from '../../lib/format';

interface Listed {
  id: string;
  sku: string;
  name: string;
  price_uzs: number;
  active: boolean;
  in_stock: boolean;
}
interface CartUpsell {
  enabled: boolean;
  product_ids: string[];
  products: Listed[];
}
interface Found {
  id: string;
  sku: string;
  name_ru: string;
  price_uzs: number;
}
const MAX = 12;

/**
 * 3.1: «Настройки → Корзина» — products under «Добавьте ещё X сум — доставка бесплатна». Empty list = the shop picks
 * them itself (in stock, not in the cart, priced close to the missing amount); a list = only these products.
 */
export function CartUpsellSettings() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'cart-upsell'], queryFn: () => api<CartUpsell>('/staff/settings/cart-upsell') });
  const [enabled, setEnabled] = useState(true);
  const [list, setList] = useState<Listed[]>([]);
  const [search, setSearch] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) {
      setEnabled(q.data.enabled);
      setList(q.data.products);
    }
  }, [q.data]);
  const found = useQuery({
    queryKey: ['upsell-products', search],
    queryFn: () => api<{ items: Found[] }>(`/staff/products?q=${encodeURIComponent(search)}&status=active`),
    enabled: search.trim().length >= 2,
  });
  const save = useMutation({
    mutationFn: () => api<CartUpsell>('/staff/settings/cart-upsell', { method: 'PUT', body: { enabled, product_ids: list.map((p) => p.id) } }),
    onSuccess: (v) => {
      client.setQueryData(['settings', 'cart-upsell'], v);
      setSaved(true);
    },
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const changed = () => setSaved(false);
  const add = (p: Found) => {
    if (list.some((x) => x.id === p.id) || list.length >= MAX) return;
    setList([...list, { id: p.id, sku: p.sku, name: p.name_ru, price_uzs: Number(p.price_uzs), active: true, in_stock: true }]);
    setSearch('');
    changed();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form className="card narrow" onSubmit={submit}>
      <h2>Допродажа в корзине</h2>
      <p className="muted">
        Под полоской «Добавьте ещё X сум — доставка бесплатна» клиент видит 2–3 товара с кнопкой [+]. Блок не показывается, когда порог уже набран
        или у клиента бесплатная доставка первого заказа. Показы и добавления считаются в «Аналитика → Воронка».
      </p>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => (setEnabled(e.target.checked), changed())} /> Показывать товары в корзине
      </label>

      <h3 style={{ marginTop: 16 }}>Товары для допродажи</h3>
      <p className="muted small">
        Список пуст — магазин подбирает сам: товары в наличии, которых нет в корзине, по цене ближе всего к недостающей сумме. Если список заполнен —
        показываются только эти товары (в наличии и подходящие по цене). До {MAX} товаров.
      </p>
      {list.length === 0 ? (
        <p className="small">
          <Badge tone="info">Автоподбор</Badge>
        </p>
      ) : (
        <table className="table">
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.name}
                  <div className="muted small">{p.sku}</div>
                </td>
                <td className="num">{money(p.price_uzs)}</td>
                <td>
                  {!p.active ? <Badge tone="bad">Скрыт</Badge> : !p.in_stock ? <Badge tone="warn">Нет в наличии</Badge> : <Badge tone="ok">В наличии</Badge>}
                </td>
                <td className="ops">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => (setList(list.filter((x) => x.id !== p.id)), changed())}>
                    Убрать
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {list.length < MAX && (
        <div className="field">
          <span className="field-label">Добавить товар</span>
          <input placeholder="Поиск по названию или SKU (от 2 букв)" value={search} onChange={(e) => setSearch(e.target.value)} />
          {found.data && search.trim().length >= 2 && (
            <ul className="pick-list">
              {found.data.items
                .filter((p) => !list.some((x) => x.id === p.id))
                .slice(0, 8)
                .map((p) => (
                  <li key={p.id}>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => add(p)}>
                      + {p.name_ru} ({p.sku}) · {money(Number(p.price_uzs))}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
      <ErrorBox error={save.error} />
      {saved && <div className="alert alert-ok">Сохранено</div>}
      <button className="btn" disabled={save.isPending}>
        Сохранить
      </button>
    </form>
  );
}
