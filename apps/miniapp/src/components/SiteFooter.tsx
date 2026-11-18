import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { useShopTexts } from '../lib/queries';
import { BrandBlock } from './HeaderParts';
import { Logo } from './Logo';

/** The shop bot: the same customer account works in Telegram and on the website (release 6). */
export const BOT_URL = (import.meta.env.VITE_BOT_URL as string | undefined) ?? 'https://t.me/vitalo_uz_bot';

/** Release 6: the website footer (not shown inside Telegram, where the bot is the "footer"). */
export function SiteFooter() {
  const { t } = useI18n();
  const support = useShopTexts().data?.support_url;
  return (
    <footer className="site-footer">
      <div className="site-footer-in">
        <div className="site-footer-brand">
          <BrandBlock logo={<Logo />} />
          <p>{t('footer.lead')}</p>
        </div>
        <nav aria-label={t('footer.shop')}>
          <h2>{t('footer.shop')}</h2>
          <Link to="/catalog">{t('nav.catalog')}</Link>
          <Link to="/search">{t('home.search')}</Link>
          <Link to="/favorites">{t('nav.favorites')}</Link>
        </nav>
        <nav aria-label={t('footer.help')}>
          <h2>{t('footer.help')}</h2>
          <Link to="/orders">{t('profile.orders')}</Link>
          {support ? (
            <a href={support} target="_blank" rel="noopener noreferrer">
              {t('profile.support')}
            </a>
          ) : (
            <Link to="/support">{t('profile.support')}</Link>
          )}
          <a href={BOT_URL} target="_blank" rel="noopener noreferrer">
            {t('footer.telegram')}
          </a>
        </nav>
        <nav aria-label={t('footer.docs')}>
          <h2>{t('footer.docs')}</h2>
          <Link to="/legal/offer">{t('legal.offer')}</Link>
          <Link to="/legal/privacy">{t('legal.privacy')}</Link>
        </nav>
      </div>
      <div className="site-footer-bottom">
        <span>{t('footer.rights', { year: new Date().getFullYear() })}</span>
        <span>{t('footer.notMedicine')}</span>
      </div>
    </footer>
  );
}
