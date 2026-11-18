import type { Metadata } from 'next';
import { Suspense } from 'react';
import { t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';
import { ReturnView } from './ReturnView';

export async function generateMetadata(): Promise<Metadata> {
  return { title: t(await getLang(), 'return.title'), robots: { index: false } };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="page">
      <div className="container">
        <Suspense>
          <ReturnView id={id} />
        </Suspense>
      </div>
    </div>
  );
}
