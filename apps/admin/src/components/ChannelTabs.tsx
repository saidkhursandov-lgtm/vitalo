import { useNavigate } from 'react-router-dom';
import { useSession } from '../lib/auth';

type Channel = 'vitalo' | 'yandex';

/**
 * Генплан, этап 2: «Все каналы / Mini App / Яндекс Маркет» above every order list. Shown only to an employee who may
 * open both lists; the Mini App and Yandex lists keep their own filters and buttons.
 */
export function ChannelTabs({ current }: { current: 'all' | Channel }) {
  const { can } = useSession();
  const navigate = useNavigate();
  if (!can('orders.view') || !can('yandex.orders.view')) return null;
  const tabs = [
    ['all', 'Все каналы', '/orders'],
    ['vitalo', 'Mini App', '/orders?channel=vitalo'],
    ['yandex', 'Яндекс Маркет', '/yandex-orders'],
  ] as const;
  return (
    <div className="segmented" role="group" aria-label="Канал">
      {tabs.map(([k, label, to]) => (
        <button key={k} type="button" className={current === k ? 'is-on' : ''} aria-pressed={current === k} onClick={() => navigate(to)}>
          {label}
        </button>
      ))}
    </div>
  );
}
