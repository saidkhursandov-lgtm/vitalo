import { useNavigate } from 'react-router-dom';
import { BellIcon, GiftIcon, OrdersIcon, type Icon } from '../components/Icons';
import { EmptyState, ErrorState, Loading } from '../components/ui';
import { track } from '../lib/analytics';
import { dateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useNotificationActions, useNotifications } from '../lib/queries';
import type { CentreItem } from '../lib/types';

const CATEGORY_ICONS: Record<CentreItem['category'], Icon> = { order: OrdersIcon, waitlist: BellIcon, promo: GiftIcon };

/**
 * 3.2: the notification centre — orders, «снова в наличии», promos. Newest first, unread ones highlighted;
 * a tap opens the order / product / promo link and marks the entry read; «Прочитать все» marks everything.
 */
export function Notifications() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const list = useNotifications(lang);
  const { read, readAll } = useNotificationActions();

  function open(n: CentreItem) {
    track('notification_open', { category: n.category, template: n.template });
    if (!n.read) read.mutate(n.id);
    if (n.path) navigate(n.path);
  }
  function onReadAll() {
    track('notification_read_all', { count: list.data?.unread ?? 0 });
    readAll.mutate();
  }

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
        <ul className="card list centre-list">
          {list.data.items.map((n) => {
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
                    <span className="hint small">{dateTime(n.created_at, lang)}</span>
                  </span>
                  {!n.read && <span className="centre-dot" aria-label={t('notifications.unread')} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
