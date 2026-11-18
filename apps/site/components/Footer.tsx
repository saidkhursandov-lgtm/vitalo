import Link from 'next/link';
import { Send } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { CategoryTrees, Lang } from '@/lib/types';
import { nameOf } from '@/lib/format';

export function Footer({ lang, categories, botUsername }: { lang: Lang; categories: CategoryTrees | null; botUsername: string }) {
  const year = new Date().getFullYear();
  const tg = `https://t.me/${botUsername}`;
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div>
            <img className="flogo" src="/brand/logo-white.png" alt="VITALO" width={140} height={34} />
            <p>{t(lang, 'footer.lead')}</p>
            <a className="btn btn-outline-light btn-sm footer-tg" href={tg} target="_blank" rel="noopener noreferrer">
              <Send size={16} strokeWidth={1.8} /> {t(lang, 'header.telegram')}
            </a>
          </div>
          <div>
            <h4>{t(lang, 'footer.shop')}</h4>
            <ul>
              <li>
                <Link href="/catalog">{t(lang, 'nav.catalog')}</Link>
              </li>
              {(categories?.need ?? []).slice(0, 5).map((c) => (
                <li key={c.id}>
                  <Link href={`/catalog/${c.slug}`}>{nameOf(c, lang)}</Link>
                </li>
              ))}
              <li>
                <Link href="/brands">{t(lang, 'nav.brands')}</Link>
              </li>
            </ul>
          </div>
          <div>
            <h4>{t(lang, 'footer.help')}</h4>
            <ul>
              <li>
                <Link href="/ai">{t(lang, 'nav.ai')}</Link>
              </li>
              <li>
                <Link href="/sets">{t(lang, 'nav.sets')}</Link>
              </li>
              <li>
                <Link href="/account">{t(lang, 'footer.orders')}</Link>
              </li>
              <li>
                <a href={tg} target="_blank" rel="noopener noreferrer">
                  {t(lang, 'footer.support')}
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h4>{t(lang, 'footer.pay')}</h4>
            <div className="pay-row">
              <span>Payme</span>
              <span>Uzcard</span>
              <span>Humo</span>
            </div>
            <h4 style={{ marginTop: 24 }}>{t(lang, 'footer.docs')}</h4>
            <ul>
              <li>
                <Link href="/legal/offer">{t(lang, 'footer.offer')}</Link>
              </li>
              <li>
                <Link href="/legal/privacy">{t(lang, 'footer.privacy')}</Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© {year} VITALO</span>
          <span>{t(lang, 'footer.notMedicine')}</span>
        </div>
      </div>
    </footer>
  );
}
