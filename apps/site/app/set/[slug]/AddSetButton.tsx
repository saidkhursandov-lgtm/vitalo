'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Check, ShoppingBag } from 'lucide-react';
import { useSession } from '@/components/Session';

/** The whole set into the cart; the set discount is applied by the cart itself (4.3) when all items are there. */
export function AddSetButton({ items }: { items: { id: string; qty: number; ok: boolean }[] }) {
  const { t, lang, addToCart } = useSession();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const allOk = items.every((i) => i.ok);
  if (state === 'done')
    return (
      <Link href="/cart" className="btn btn-lg btn-secondary btn-block">
        <Check size={18} strokeWidth={2.2} /> {t('product.toCart')}
      </Link>
    );
  return (
    <>
      <button
        type="button"
        className="btn btn-lg btn-block"
        disabled={state === 'busy' || !allOk}
        onClick={async () => {
          setState('busy');
          try {
            for (const i of items) await addToCart(i.id, i.qty);
            setState('done');
          } catch {
            setState('idle');
          }
        }}
      >
        <ShoppingBag size={18} strokeWidth={1.8} /> {lang === 'uz' ? 'To‘plamni savatga' : 'Весь сет в корзину'}
      </button>
      {!allOk ? <p className="hint">{t('cart.unavailable')}</p> : null}
    </>
  );
}
