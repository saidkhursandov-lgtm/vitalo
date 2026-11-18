'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Bell, Gift, Info, LifeBuoy, Package } from 'lucide-react';
import { api } from '@/lib/client';
import { dateTime } from '@/lib/format';
import type { CentreItem, CentreList, CentreTab } from '@/lib/types';
import { useSession } from '@/components/Session';
import { AccountShell, sitePath } from '@/components/AccountShell';

const TABS: CentreTab[] = ['orders', 'promo', 'service', 'personal'];
const ICONS: Record<CentreItem['category'], typeof Bell> = { order: Package, waitlist: Bell, promo: Gift, compat: LifeBuoy, personal: LifeBuoy };

/** The notification centre: the same cards as the Mini App bell (one card per order), read marks are shared. */
export function NotificationsView() {
  const { t } = useSession();
  return (
    <AccountShell section="notifications" title={t('notifications.title')}>
      <Centre />
    </AccountShell>
  );
}

function Centre() {
  const { t, lang } = useSession();
  const router = useRouter();
  const [list, setList] = useState<CentreList | null>(null);
  const [chosen, setChosen] = useState<CentreTab | null>(null);

  const load = useCallback(() => api<CentreList>(`/notifications?lang=${lang}`).then(setList, () => setList({ unread: 0, tabs: { personal: 0, orders: 0, promo: 0, service: 0 }, items: [] })), [lang]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!list) {
    return (
      <div className="wait">
        <span className="spinner" aria-label={t('common.loading')} />
      </div>
    );
  }
  if (!list.items.length) {
    return (
      <div className="empty">
        <span className="empty-ic">
          <Bell size={40} strokeWidth={1.6} />
        </span>
        <h2>{t('notifications.emptyTitle')}</h2>
        <p>{t('notifications.empty')}</p>
      </div>
    );
  }

  const tab = chosen ?? TABS.find((k) => list.tabs[k]) ?? TABS.find((k) => list.items.some((n) => n.tab === k)) ?? 'orders';
  const items = list.items.filter((n) => n.tab === tab);

  async function open(n: CentreItem) {
    if (!n.read) await api(`/notifications/${n.id}/read`, { method: 'POST', body: {} }).catch(() => null);
    const to = sitePath(n.path);
    if (to) router.push(to);
    else void load();
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="sec-head">
        <div className="chip-row" role="tablist">
          {TABS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={k === tab} className={`chip${k === tab ? ' is-on' : ''}`} onClick={() => setChosen(k)}>
              {t(`notifications.tab.${k}`)}
              {list.tabs[k] ? <span className="count">{list.tabs[k]}</span> : null}
            </button>
          ))}
        </div>
        {list.unread ? (
          <button type="button" className="link" onClick={() => void api('/notifications/read-all', { method: 'POST', body: {} }).then(load, () => null)}>
            {t('notifications.readAll')}
          </button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <div className="empty">
          <span className="empty-ic">
            <Info size={40} strokeWidth={1.6} />
          </span>
          <h2>{t('notifications.emptyTab')}</h2>
        </div>
      ) : (
        <ul className="card centre-list">
          {items.map((n) => {
            const I = ICONS[n.category] ?? Bell;
            return (
              <li key={n.id}>
                <button type="button" className={`centre-item${n.read ? '' : ' is-unread'}`} onClick={() => void open(n)}>
                  <span className="centre-icon">
                    <I size={20} strokeWidth={1.8} />
                  </span>
                  <span className="centre-text">
                    <b>{n.title}</b>
                    <span>{n.body}</span>
                    {n.steps.length > 1 ? <span className="hint">{n.steps.join(' → ')}</span> : null}
                    <span className="hint">{dateTime(n.created_at, lang)}</span>
                  </span>
                  {!n.read ? <span className="dot" aria-label={t('notifications.unread')} /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
