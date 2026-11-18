import type { Metadata, Viewport } from 'next';
import { Suspense, type ReactNode } from 'react';
import './globals.css';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { AiFab, BottomNav } from '@/components/BottomNav';
import { SessionProvider } from '@/components/Session';
import { TelegramRedirect } from '@/components/TelegramRedirect';
import { catalog } from '@/lib/server-api';
import { t } from '@/lib/i18n';
import { botUsername, getLang, miniAppUrl, siteUrl } from '@/lib/lang';

export async function generateMetadata(): Promise<Metadata> {
  const lang = await getLang();
  return {
    metadataBase: new URL(siteUrl()),
    title: { default: t(lang, 'meta.title'), template: '%s — VITALO' },
    description: t(lang, 'meta.description'),
    icons: { icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }, { url: '/brand/icon-32.png', sizes: '32x32' }], apple: '/brand/icon-192.png' },
    openGraph: { siteName: 'VITALO', type: 'website', locale: lang === 'uz' ? 'uz_UZ' : 'ru_RU' },
  };
}

export const viewport: Viewport = { themeColor: '#002D62', width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = await getLang();
  const categories = await catalog.categories().catch(() => null);
  const bot = botUsername();
  return (
    <html lang={lang === 'uz' ? 'uz-Latn' : 'ru'}>
      <body className="has-bottom-nav">
        <TelegramRedirect appUrl={miniAppUrl()} />
        <SessionProvider lang={lang} botUsername={bot}>
          <Suspense>
            <Header categories={categories} />
          </Suspense>
          <main>{children}</main>
          <Footer lang={lang} categories={categories} botUsername={bot} />
          <BottomNav />
          <AiFab />
        </SessionProvider>
      </body>
    </html>
  );
}
