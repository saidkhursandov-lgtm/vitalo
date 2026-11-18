import type { Metadata } from 'next';
import { t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';
import { CartView } from './CartView';

export async function generateMetadata(): Promise<Metadata> {
  return { title: t(await getLang(), 'cart.title'), robots: { index: false } };
}

export default async function CartPage() {
  const lang = await getLang();
  return (
    <div className="page">
      <div className="container">
        <h1 className="page-title">{t(lang, 'cart.title')}</h1>
        <CartView />
      </div>
    </div>
  );
}
