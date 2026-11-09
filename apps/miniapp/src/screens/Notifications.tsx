import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BellIcon, GiftIcon, InfoIcon, OrdersIcon, SupportIcon, type Icon } from '../components/Icons';
import { EmptyState, ErrorState, Loading } from '../components/ui';
import { track } from '../lib/analytics';
import { dateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useNotificationActions, useNotifications } from '../lib/queries';
import type { CentreItem, CentreTab } from '../lib/types';

const TABS: CentreTab[] = ['personal', 'orders', 'promo', 'service'];
const CATEGORY_ICONS: Record<CentreItem['category'], Icon> = { order: OrdersIcon, waitlist: BellIcon, promo: GiftIcon, compat: SupportIcon, personal: SupportIcon };
const TAB_ICONS: Record<CentreTab, Icon> = { personal: SupportIcon, orders: OrdersIcon, promo: GiftIcon, service: InfoIcon };

/**
 * 3.2: the notification centre in three tabs — «Заказы», «Акции и бонусы», «Сервисные» (снова в наличии и др.).
 * An order is one card: its latest status, the path «Принят → Оплачен → …» and a note about the intake memo; it goes up
 * and turns unread on every change. A tap opens the order / product / promo link and marks the card read.
 * Opens on the first tab with something unread.
 */
export function Notifications() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const list = useNotifications(lang);
  const { read, readAll } = useNotificationActions();
  const [chosen, setChosen] = useState<CentreTab | null>(null);
  const tab = chosen ?? TABS.find((k) => list.data?.tabs[k]) ?? 'orders';

  function open(n: CentreItem) {
    track('notification_open', { category: n.category, template: n.template, tab: n.tab });
    if (!n.read) read.mutate(n.id);
    if (n.path) navigate(n.path);
  }
  function onReadAll() {
    track('notification_read_all', { count: list.data?.unread ?? 0 });
    readAll.mutate();
  }

  const items = list.data?.items.filter((n) => n.tab === tab) ?? [];
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('notifications.title')}</h1>
        {!!list.data?.unread && (
          <button type="button" className="link-btn" disabled={readAll.isPending} onClick={onReadAll}>
            {t('notifications.readAll')}
          </button>
        )}
      </div>
      {list.isPending ? (
        <Loading variant="list" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={BellIcon} title={t('notifications.emptyTitle')} text={t('notifications.empty')} />
      ) : (
        <>
          <div className="chips scroll-x centre-tabs" role="tablist">
            {TABS.map((k) => (
              <button key={k} type="button" role="tab" aria-selected={k === tab} className={`chip${k === tab ? ' is-on' : ''}`} onClick={() => setChosen(k)}>
                {t(`notifications.tab.${k}`)}
                {!!list.data.tabs[k] && <span className="centre-tab-count">{list.data.tabs[k]}</span>}
              </button>
            ))}
          </div>
          {/* 6а-Д: «Личные» — the specialist's replies; all questions are one tap away */}
          {tab === 'personal' && (
            <Link to="/support" className="link centre-support-link">
              {t('support.listTitle')} ›
            </Link>
          )}
          {items.length === 0 ? (
            <EmptyState icon={TAB_ICONS[tab]} title={t('notifications.emptyTab')} />
          ) : (
            <ul className="card list centre-list" role="tabpanel">
              {items.map((n) => {
                const I = CATEGORY_ICONS[n.category] ?? BellIcon;
                return (
                  <li key={n.id}>
                    <button type="button" className={`centre-item${n.read ? '' : ' is-unread'}`} onClick={() => open(n)}>
                      <span className={`centre-icon centre-icon-${n.category}`} aria-hidden>
                        <I width={20} height={20} />
                      </span>
                      <span className="centre-text">
                        <strong>{n.title}</strong>
                        <span>{n.body}</span>
                        {n.steps.length > 1 && <span className="centre-steps">{n.steps.join(' → ')}</span>}
                        {n.has_guide && <span className="centre-guide">{t('notifications.guide')}</span>}
                        <span className="hint small">{dateTime(n.created_at, lang)}</span>
                      </span>
                      {!n.read && <span className="centre-dot" aria-label={t('notifications.unread')} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
