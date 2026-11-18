import { Link } from 'react-router-dom';
import { money } from '../lib/format';
import { ProductPicker } from '../pages/Purchases';

export interface VariantRow {
  id: string;
  sku: string;
  name_ru: string;
  status: string;
  price_uzs: number;
  variant_label_ru: string | null;
}

/** undefined — not changed; a product — join its pack sizes; null — leave the group. */
export type VariantOf = { id: string; sku: string; name_ru: string } | null | undefined;

const STATUS: Record<string, string> = { active: 'в продаже', hidden: 'скрыт', archived: 'в архиве' };

/**
 * D-79 «Фасовки» in the admin product card: the other pack sizes / doses of this product. Each is a product of its own
 * (SKU, stock, price); in the shop they are «Фасовка» buttons on each other's card.
 */
export function VariantsField({
  productId,
  variants,
  value,
  disabled,
  labelRu,
  labelUz,
  onLabel,
  onChange,
}: {
  productId: string | null;
  variants: VariantRow[];
  value: VariantOf;
  disabled: boolean;
  labelRu: string;
  labelUz: string;
  onLabel: (lang: 'ru' | 'uz', v: string) => void;
  onChange: (v: VariantOf) => void;
}) {
  const leaving = value === null;
  const shown = leaving ? [] : variants;
  return (
    <div>
      <p className="muted small">Один товар в разных фасовках или дозировках (60 и 120 капсул, 1000 и 5000 МЕ). Каждая фасовка — отдельный товар со своим артикулом, остатком и ценой; в магазине на карточке они — кнопки «Фасовка».</p>
      <div className="form-row">
        <label>
          Подпись фасовки (RU)
          <input aria-label="Подпись фасовки (RU)" maxLength={40} value={labelRu} disabled={disabled} placeholder="60 капсул" onChange={(e) => onLabel('ru', e.target.value)} />
        </label>
        <label>
          Подпись фасовки (UZ)
          <input aria-label="Подпись фасовки (UZ)" maxLength={40} value={labelUz} disabled={disabled} placeholder="60 kapsula" onChange={(e) => onLabel('uz', e.target.value)} />
        </label>
      </div>
      {!!shown.length && (
        <ul className="small" aria-label="Другие фасовки">
          {shown.map((v) => (
            <li key={v.id}>
              <Link to={`/products/${v.id}`}>
                {v.variant_label_ru || v.sku} — {v.sku} · {v.name_ru}
              </Link>{' '}
              <span className="muted">
                {money(v.price_uzs)} · {STATUS[v.status] ?? v.status}
              </span>
            </li>
          ))}
        </ul>
      )}
      {value ? (
        <p className="small">
          Станет фасовкой товара: {value.sku} · {value.name_ru}{' '}
          {!disabled && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(undefined)}>
              Отменить
            </button>
          )}
        </p>
      ) : leaving ? (
        <p className="small">
          Товар уберётся из фасовок после сохранения.{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(undefined)}>
            Отменить
          </button>
        </p>
      ) : (
        !disabled && (
          variants.length ? (
            <p className="muted small">
              Чтобы добавить ещё фасовку, откройте её карточку и выберите там этот товар.{' '}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(null)}>
                Убрать этот товар из фасовок
              </button>
            </p>
          ) : (
            <>
              <p className="muted small">Это фасовка другого товара? Выберите его:</p>
              <ProductPicker exclude={productId ? [productId] : []} onPick={(p) => onChange(p)} />
            </>
          )
        )
      )}
    </div>
  );
}
