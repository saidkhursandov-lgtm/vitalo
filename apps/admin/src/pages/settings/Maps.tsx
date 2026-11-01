import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, ErrorBox, Loading } from '../../components/ui';
import { api } from '../../lib/api';

interface MapsStatus {
  enabled: boolean;
  has_js_key: boolean;
  has_geocoder_key: boolean;
  available: boolean;
  reason: 'off' | 'no_key' | 'limit' | null;
  today: { date: string; geocoder_requests: number; map_opens: number };
  limit: number;
  warn_at: number;
  hide_at: number;
}

/**
 * 3.6: «Настройки → Доставка → Карта». The switch of «Выбрать на карте» in the Mini App and today's requests to Yandex:
 * the free plan allows 1000 geocoder requests a day, the shop hides the button itself at 900 (until midnight, Tashkent).
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
  const used = s.today.geocoder_requests;
  const tone = used >= s.hide_at ? 'bad' : used >= s.warn_at ? 'warn' : 'ok';

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
          вписывают в файл .env на сервере (не в админке).
        </p>
      )}

      <h3 style={{ marginTop: 16 }}>Запросы к Яндексу сегодня ({s.today.date.split('-').reverse().join('.')})</h3>
      <p>
        Поиск адреса по точке: <Badge tone={tone}>{used} из {s.limit}</Badge>
      </p>
      <p className="muted small">Открытий карты: {s.today.map_opens}. Счётчик обнуляется в полночь по Ташкенту.</p>
      {used >= s.hide_at ? (
        <div className="alert alert-error" style={{ display: 'block' }}>
          Лимит почти исчерпан: кнопка карты скрыта до полуночи, клиенты вводят адрес вручную. При регулярном превышении 1000 запросов Яндекс
          блокирует ключ навсегда — если так бывает часто, нужна платная лицензия.
        </div>
      ) : used >= s.warn_at ? (
        <div className="alert alert-warn" style={{ display: 'block' }}>
          Близко к лимиту: на {s.hide_at} запросах карта сама скроется до полуночи.
        </div>
      ) : null}
    </section>
  );
}
