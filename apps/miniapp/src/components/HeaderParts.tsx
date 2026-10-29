import { track } from '../lib/analytics';
import { useI18n } from '../lib/i18n';
import type { Lang } from '../lib/types';
import { PlusIcon } from './Icons';

const LANGS: { code: Lang; label: string }[] = [
  { code: 'ru', label: 'RU' },
  { code: 'uz', label: 'UZ' },
];

/** «✚ Выбор врача» (D-03) next to the logo; the cross is an SVG icon, not an emoji. */
export function DoctorBadge() {
  const { t } = useI18n();
  return (
    <span className="doctor-badge">
      <PlusIcon width={11} height={11} strokeWidth={3} />
      {t('header.doctor')}
    </span>
  );
}

/** RU | UZ in one tap: the choice is applied at once on every screen and saved on the server (setLang). */
export function LangSwitch() {
  const { t, lang, setLang } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label={t('header.lang')}>
      {LANGS.map((l) => (
        <button
          key={l.code}
          type="button"
          className={lang === l.code ? 'is-on' : ''}
          aria-pressed={lang === l.code}
          onClick={() => {
            if (lang === l.code) return;
            setLang(l.code);
            track('language_change', { to: l.code });
          }}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

/** Logo with the doctor badge under it: the same left side of the top bar on every screen. */
export function BrandBlock({ logo }: { logo: React.ReactNode }) {
  return (
    <span className="brand-block">
      {logo}
      <DoctorBadge />
    </span>
  );
}
