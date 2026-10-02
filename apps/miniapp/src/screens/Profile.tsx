import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronIcon } from '../components/Icons';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useOrders } from '../lib/queries';
import type { Lang } from '../lib/types';
import { OrderRow } from './Orders';

export function Profile() {
  const { t, lang, setLang } = useI18n();
  const user = useUser();
  const orders = useOrders();
  const recent = orders.data?.pages[0].items.slice(0, 3) ?? [];
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const [marketing, setMarketing] = useState(user.marketing_opt_in);
  const toggleMarketing = (on: boolean) => {
    setMarketing(on);
    api('/auth/me', { method: 'PATCH', body: { marketing_opt_in: on } }).catch(() => setMarketing(!on));
  };

  return (
    <div className="page">
      <div className="profile-head">
        <div className="avatar" aria-hidden>
          {user.first_name.slice(0, 1).toUpperCase()}
        </div>
        <div>
          <h1>{name}</h1>
          {user.username && <div className="hint">@{user.username}</div>}
        </div>
      </div>

      <section className="card">
        <h2>{t('profile.language')}</h2>
        <div className="segmented">
          {(['ru', 'uz'] as Lang[]).map((l) => (
            <button key={l} className={lang === l ? 'is-on' : ''} onClick={() => setLang(l)}>
              {l === 'ru' ? 'Русский' : 'O‘zbekcha'}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>{t('profile.notifications')}</h2>
        <label className="check-row">
          <input type="checkbox" checked={marketing} onChange={(e) => toggleMarketing(e.target.checked)} />
          {t('profile.marketing')}
        </label>
        <p className="hint small">{t('profile.serviceAlways')}</p>
      </section>

      <section className="card list">
        <Link to="/orders" className="list-row">
          <span>{t('profile.orders')}</span>
          <ChevronIcon width={18} height={18} />
        </Link>
        <Link to="/favorites" className="list-row">
          <span>{t('profile.favorites')}</span>
          <ChevronIcon width={18} height={18} />
        </Link>
        <Link to="/profile/addresses" className="list-row">
          <span>{t('profile.addresses')}</span>
          <ChevronIcon width={18} height={18} />
        </Link>
      </section>

      {recent.length > 0 && (
        <section className="card list">
          <h2>{t('profile.recentOrders')}</h2>
          {recent.map((o) => (
            <OrderRow key={o.id} order={o} />
          ))}
        </section>
      )}
    </div>
  );
}
