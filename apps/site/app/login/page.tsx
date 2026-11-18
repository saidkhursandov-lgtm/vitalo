import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Check } from 'lucide-react';
import { t } from '@/lib/i18n';
import { getLang } from '@/lib/lang';
import { LoginForm } from './LoginForm';

export async function generateMetadata(): Promise<Metadata> {
  return { title: t(await getLang(), 'login.title'), robots: { index: false } };
}

export default async function LoginPage() {
  const lang = await getLang();
  return (
    <div className="page">
      <div className="container">
        <div className="auth">
          <Suspense>
            <LoginForm />
          </Suspense>
          <div className="auth-side">
            <div>
              <span className="kicker" style={{ color: 'var(--on-primary)' }}>
                VITALO
              </span>
              <h2 style={{ marginTop: 14 }}>{t(lang, 'home.tgTitle')}</h2>
              <p style={{ color: 'var(--on-primary-muted)', marginTop: 12 }}>{t(lang, 'home.tgText')}</p>
            </div>
            <ul className="tg-list">
              <li>
                <Check size={16} strokeWidth={2.4} /> {t(lang, 'login.why1')}
              </li>
              <li>
                <Check size={16} strokeWidth={2.4} /> {t(lang, 'login.why2')}
              </li>
              <li>
                <Check size={16} strokeWidth={2.4} /> {t(lang, 'login.why3')}
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
