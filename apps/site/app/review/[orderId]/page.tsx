import type { Metadata } from 'next';
import { Suspense } from 'react';
import { t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';
import { ReviewView } from './ReviewView';

export async function generateMetadata(): Promise<Metadata> {
  return { title: t(await getLang(), 'review.title'), robots: { index: false } };
}

export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return (
    <div className="page">
      <div className="container">
        <Suspense>
          <ReviewView orderId={orderId} />
        </Suspense>
      </div>
    </div>
  );
}
