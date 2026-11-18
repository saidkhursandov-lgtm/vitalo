import type { Metadata } from 'next';
import { Suspense } from 'react';
import { t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';
import { SupportThreadView } from '../SupportView';

export async function generateMetadata(): Promise<Metadata> {
  return { title: t(await getLang(), 'support.listTitle'), robots: { index: false } };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="page">
      <div className="container">
        <Suspense>
          <SupportThreadView id={id} />
        </Suspense>
      </div>
    </div>
  );
}
