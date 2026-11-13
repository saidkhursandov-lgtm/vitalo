import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronIcon } from '../components/Icons';
import { BonusCard } from '../components/Bonus';
import { api } from '../lib/api';
import { useUser } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { useOrders } from '../lib/queries';
import { OrderRow } from './Orders';

export function Profile() {
  const { t } = useI18n();
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

      {/* 3.10-А: the real balance (the «Скоро» card while the programme is off and the balance is empty) */}
      <BonusCard />

      {/* 2.2: no «Язык» block here — the language is switched with RU | UZ in the header (saved on the server). */}

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
        {/* 6б-А: support lives inside the Mini App (the questions and the replies); Telegram is the last line there */}
        <Link to="/support" className="list-row">
          <span>{t('profile.support')}</span>
          <ChevronIcon width={18} height={18} />
        </Link>
        {/* 6б-А: one row instead of the «Уведомления в Telegram» block; order messages come always */}
        <label className="list-row switch-row">
          <span>{t('profile.marketingRow')}</span>
          <input type="checkbox" role="switch" className="switch" checked={marketing} onChange={(e) => toggleMarketing(e.target.checked)} />
        </label>
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
