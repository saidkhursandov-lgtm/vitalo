import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, ErrorBox, Loading } from '../../components/ui';
import { api } from '../../lib/api';

interface Limit {
  limit: number;
  warn_at: number;
  hide_at: number;
}
interface MapsStatus {
  enabled: boolean;
  has_js_key: boolean;
  has_geocoder_key: boolean;
  available: boolean;
  reason: 'off' | 'no_key' | 'limit' | null;
  today: { date: string; geocoder_requests: number; map_loads: number; map_confirms: number };
  geocoder: Limit;
  js: Limit;
}

const tone = (used: number, l: Limit) => (used >= l.hide_at ? 'bad' : used >= l.warn_at ? 'warn' : 'ok');

/**
 * 3.6: «Настройки → Доставка → Карта». The switch of «Выбрать на карте» in the Mini App and today's requests to Yandex.
 * The free plan allows 100 map loads (JavaScript API) and 1000 geocoder requests a day; the shop hides the button itself
 * at 90 / 900 (until midnight, Tashkent).
 */
export function MapsSettings() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'maps'], queryFn: () => api<MapsStatus>('/staff/settings/maps'), refetchInterval: 60_000 });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api<MapsStatus>('/staff/settings/maps', { method: 'PUT', body: { enabled } }),
    onSuccess: (v) => client.setQueryData(['settings', 'maps'], v),
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const loads = s.today.map_loads;
  const geo = s.today.geocoder_requests;
  const hidden = loads >= s.js.hide_at || geo >= s.geocoder.hide_at;
  const near = loads >= s.js.warn_at || geo >= s.geocoder.warn_at;

  return (
    <section className="card narrow">
      <h2>Карта (Яндекс)</h2>
      <p className="muted">
        Кнопка «Выбрать на карте» в корзине, при оформлении и в «Профиль → Адреса». Ручной ввод адреса работает всегда. Точку на карте сотрудники
        видят в карточке заказа и в сообщении о новом заказе («Открыть в Яндекс Картах»).
      </p>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
        <input type="checkbox" checked={s.enabled} disabled={save.isPending} onChange={(e) => save.mutate(e.target.checked)} /> Показывать карту в Mini App
      </label>
      {save.isError && <ErrorBox error={save.error} />}

      <p>
        Сейчас у клиентов:{' '}
        {s.available ? (
          <Badge tone="ok">Карта работает</Badge>
        ) : s.reason === 'off' ? (
          <Badge tone="info">Выключена</Badge>
        ) : s.reason === 'no_key' ? (
          <Badge tone="bad">Нет ключей Яндекса на сервере</Badge>
        ) : (
          <Badge tone="bad">Скрыта до полуночи: почти исчерпан суточный лимит</Badge>
        )}
      </p>
      {!(s.has_js_key && s.has_geocoder_key) && (
        <p className="muted small">
          Не хватает ключа: {[!s.has_js_key && 'YANDEX_MAPS_JS_API_KEY', !s.has_geocoder_key && 'YANDEX_GEOCODER_API_KEY'].filter(Boolean).join(', ')} — его
          вписывают в настройки сервера (не в админке).
        </p>
      )}

      <h3 style={{ marginTop: 16 }}>Запросы к Яндексу сегодня ({s.today.date.split('-').reverse().join('.')})</h3>
      <p>
        Открытий карты: <Badge tone={tone(loads, s.js)}>{loads} из {s.js.limit}</Badge>
      </p>
      <p>
        Поиск адреса по точке: <Badge tone={tone(geo, s.geocoder)}>{geo} из {s.geocoder.limit}</Badge>
      </p>
      <p className="muted small">Адресов подтверждено на карте: {s.today.map_confirms}. Счётчики обнуляются в полночь по Ташкенту.</p>
      {hidden ? (
        <div className="alert alert-error" style={{ display: 'block' }}>
          Лимит почти исчерпан: кнопка карты скрыта до полуночи, клиенты вводят адрес вручную. При регулярном превышении бесплатного лимита Яндекс
          блокирует ключ навсегда — если так бывает часто, нужна платная лицензия.
        </div>
      ) : near ? (
        <div className="alert alert-warn" style={{ display: 'block' }}>
          Близко к лимиту: на {s.js.hide_at} открытиях карты или {s.geocoder.hide_at} поисках адреса кнопка сама скроется до полуночи.
        </div>
      ) : null}
    </section>
  );
}
