import type { Metadata } from 'next';
import { Suspense } from 'react';
import { t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';
import { CheckoutView } from './CheckoutView';

export async function generateMetadata(): Promise<Metadata> {
  return { title: t(await getLang(), 'checkout.title'), robots: { index: false } };
}

export default async function CheckoutPage() {
  const lang = await getLang();
  return (
    <div className="page container">
      <h1 className="page-title">{t(lang, 'checkout.title')}</h1>
      <Suspense>
        <CheckoutView />
      </Suspense>
    </div>
  );
}
