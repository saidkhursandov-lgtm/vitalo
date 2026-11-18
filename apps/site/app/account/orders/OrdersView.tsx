'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Package } from 'lucide-react';
import { api } from '@/lib/client';
import type { OrderListItem, Page } from '@/lib/types';
import { useSession } from '@/components/Session';
import { AccountShell } from '@/components/AccountShell';
import { OrderRow } from '@/components/OrderBits';

/** All orders of the account, newest first — from the site, the Mini App and the bot alike. */
export function OrdersView() {
  const { t } = useSession();
  return (
    <AccountShell section="orders" title={t('orders.title')}>
      <OrdersList />
    </AccountShell>
  );
}

function OrdersList() {
  const { t } = useSession();
  const [pages, setPages] = useState<Page<OrderListItem>[]>([]);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = (page: number) => {
    setBusy(true);
    setFailed(false);
    api<Page<OrderListItem>>(`/orders?page=${page}`)
      .then((p) => setPages((list) => [...list.filter((x) => x.page !== p.page), p]))
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  useEffect(() => load(1), []);

  const items = pages.flatMap((p) => p.items);
  const last = pages[pages.length - 1];

  if (!pages.length && busy) {
    return (
      <div className="wait">
        <span className="spinner" aria-label={t('common.loading')} />
      </div>
    );
  }
  if (!pages.length && failed) {
    return (
      <div className="notice notice-error" role="alert">
        {t('common.error')}{' '}
        <button type="button" className="link" onClick={() => load(1)}>
          {t('common.retry')}
        </button>
      </div>
    );
  }
  if (!items.length) {
    return (
      <div className="empty">
        <span className="empty-ic">
          <Package size={40} strokeWidth={1.6} />
        </span>
        <h2>{t('orders.emptyTitle')}</h2>
        <p>{t('orders.empty')}</p>
        <Link href="/catalog" className="btn">
          {t('home.heroCatalog')}
        </Link>
      </div>
    );
  }
  return (
    <div className="card order-list">
      {items.map((o) => (
        <OrderRow key={o.id} order={o} />
      ))}
      {last && last.page < last.total_pages ? (
        <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={() => load(last.page + 1)}>
          {t('acc.more')}
        </button>
      ) : null}
    </div>
  );
}
