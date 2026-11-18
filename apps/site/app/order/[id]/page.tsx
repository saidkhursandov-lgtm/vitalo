import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getLang } from '@/lib/lang';
import { t } from '@/lib/i18n';
import { OrderView } from './OrderView';

export async function generateMetadata(): Promise<Metadata> {
  return { title: t(await getLang(), 'order.title', { n: '' }).replace(/№\s*$/, '').trim(), robots: { index: false } };
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="page container">
      <Suspense>
        <OrderView id={id} />
      </Suspense>
    </div>
  );
}
