import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { onNetworkChange } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { OfflineIcon } from './Icons';

/**
 * "Нет связи. Повторить": shown when a request got no answer (timeout or lost connection) or the phone
 * went offline; hidden as soon as any answer arrives. «Повторить» reloads what is on the screen.
 */
export function NetworkBanner() {
  const { t } = useI18n();
  const client = useQueryClient();
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const off = onNetworkChange(setOffline);
    const goOffline = () => setOffline(true);
    window.addEventListener('offline', goOffline);
    return () => {
      off();
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="net-banner" role="alert">
      <OfflineIcon width={20} height={20} />
      <span>
        <strong>{t('net.title')}.</strong> {t('net.text')}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void client.refetchQueries({ type: 'active' }).finally(() => setBusy(false));
        }}
      >
        {t('common.retry')}
      </button>
    </div>
  );
}
