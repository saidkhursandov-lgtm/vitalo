import { ProductPicker } from '../pages/Purchases';

export interface PairValue {
  mode: 'auto' | 'manual' | 'off';
  product: { id: string; sku: string; name_ru: string } | null;
}

/** 4.1 «Идеальная пара» in the admin product card: picked by the rules, chosen by hand, or not shown. */
export function PairField({ productId, value, disabled, onChange }: { productId: string | null; value: PairValue; disabled: boolean; onChange: (v: PairValue) => void }) {
  return (
    <div>
      <select
        aria-label="Идеальная пара"
        style={{ maxWidth: 320 }}
        value={value.mode === 'manual' && !value.product ? 'manual' : value.mode}
        disabled={disabled}
        onChange={(e) => onChange({ mode: e.target.value as PairValue['mode'], product: e.target.value === 'manual' ? value.product : null })}
      >
        <option value="auto">Подбирается сама</option>
        <option value="manual">Выбрать товар</option>
        <option value="off">Не показывать</option>
      </select>
      {value.mode === 'auto' && <p className="muted small">По одобренным правилам «синергия»: товар в наличии с недостающим веществом (D3 → K2, магний → B6).</p>}
      {value.mode === 'manual' && (
        <>
          {value.product ? (
            <p className="small">
              {value.product.sku} · {value.product.name_ru}{' '}
              {!disabled && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ mode: 'manual', product: null })}>
                  Изменить
                </button>
              )}
            </p>
          ) : (
            !disabled && <ProductPicker exclude={productId ? [productId] : []} onPick={(p) => onChange({ mode: 'manual', product: p })} />
          )}
          <p className="muted small">Если выбранного товара нет в наличии, пара подбирается сама.</p>
        </>
      )}
    </div>
  );
}

export function pairOf(product: { pair_off?: boolean; pair_product?: PairValue['product'] } | null | undefined): PairValue {
  if (product?.pair_off) return { mode: 'off', product: null };
  if (product?.pair_product) return { mode: 'manual', product: product.pair_product };
  return { mode: 'auto', product: null };
}
