import type { Metadata } from 'next';
import { Suspense } from 'react';
import { t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';
import { NotificationsView } from './NotificationsView';

export async function generateMetadata(): Promise<Metadata> {
  return { title: t(await getLang(), 'notifications.title'), robots: { index: false } };
}

export default async function Page() {
  return (
    <div className="page">
      <div className="container">
        <Suspense>
          <NotificationsView />
        </Suspense>
      </div>
    </div>
  );
}
