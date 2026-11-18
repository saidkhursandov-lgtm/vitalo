import type { Metadata } from 'next';
import { Suspense } from 'react';
import { t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';
import { AddressesView } from './AddressesView';

export async function generateMetadata(): Promise<Metadata> {
  return { title: t(await getLang(), 'addresses.title'), robots: { index: false } };
}

export default async function Page() {
  return (
    <div className="page">
      <div className="container">
        <Suspense>
          <AddressesView />
        </Suspense>
      </div>
    </div>
  );
}
