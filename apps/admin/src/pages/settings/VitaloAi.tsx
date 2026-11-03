import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge, ErrorBox, Field, Loading } from '../../components/ui';
import { api } from '../../lib/api';
import { usd } from '../CompatAi';

export interface AiSettings {
  enabled: boolean;
  model: string;
  monthly_budget_usd: number;
  cart_daily_limit: number;
  chat_daily_limit: number;
}
export interface AiSettingsView {
  settings: AiSettings;
  defaults: AiSettings;
  key_set: boolean;
  models: { id: string; input: number; output: number }[];
  today: { requests: number; cost_usd: number };
  month: { requests: number; cost_usd: number };
  month_failed: number;
}

const MODEL_NAME: Record<string, string> = {
  'claude-haiku-5-5': 'Haiku — быстрая и недорогая (рекомендуется)',
  'claude-sonnet-5-5': 'Sonnet — точнее, примерно в 20 раз дороже',
  'claude-opus-5-5': 'Opus — самая сильная, примерно в 40 раз дороже',
};

/**
 * 3.8: «Настройки → VITALO AI» (spec 1.1, 1.7). On / off, the model, the monthly budget in $, the daily limits; the
 * spend today and this month. The Claude API key lives only in .env on the server — here only whether it is set.
 */
export function VitaloAiSettings() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'vitalo-ai'], queryFn: () => api<AiSettingsView>('/staff/ai/settings') });
  const [form, setForm] = useState<AiSettings | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm(q.data.settings);
  }, [q.data, form]);
  const save = useMutation({
    mutationFn: (settings: AiSettings) => api<AiSettingsView>('/staff/ai/settings', { method: 'PUT', body: { settings } }),
    onSuccess: (v) => {
      client.setQueryData(['settings', 'vitalo-ai'], v);
      setForm(v.settings);
    },
  });
  if (q.isPending || !form) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const budget = s.settings.monthly_budget_usd;
  const used = budget > 0 ? s.month.cost_usd / budget : 1;
  const set = <K extends keyof AiSettings>(k: K, v: AiSettings[K]) => setForm({ ...form, [k]: v });
  const num = (v: string) => (v.trim() === '' ? 0 : Number(v.replace(',', '.')));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(form);
  };

  return (
    <>
      <section className="card narrow">
        <h2>VITALO AI</h2>
        <p className="muted">
          Проверка совместимости корзины (и чат — с подэтапа 3.9). Когда AI выключен, нет ключа или кончился бюджет, покупатель видит «Ответ
          готовит специалист VITALO», а запрос уходит специалисту.
        </p>
        <p>
          Сейчас у покупателей:{' '}
          {!s.key_set ? (
            <Badge tone="bad">Нет ключа Claude на сервере</Badge>
          ) : !s.settings.enabled ? (
            <Badge tone="info">Выключен — отвечает специалист</Badge>
          ) : used >= 1 ? (
            <Badge tone="bad">Бюджет месяца исчерпан — отвечает специалист</Badge>
          ) : (
            <Badge tone="ok">Работает</Badge>
          )}
        </p>
        {!s.key_set && (
          <p className="muted small">Ключ ANTHROPIC_API_KEY вписывают в файл .env на сервере (не в админке), затем перезапускают API.</p>
        )}
        <form onSubmit={submit}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
            <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> VITALO AI включён
          </label>
          <Field label="Модель">
            <select value={form.model} onChange={(e) => set('model', e.target.value)}>
              {s.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {MODEL_NAME[m.id] ?? m.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Бюджет на месяц, $" hint="Когда расход месяца дойдёт до бюджета, новые запросы к модели не отправляются до 1-го числа (по Ташкенту).">
            <input type="number" min={0} step="1" inputMode="decimal" value={form.monthly_budget_usd} onChange={(e) => set('monthly_budget_usd', num(e.target.value))} />
          </Field>
          <Field label="Новых AI-проверок корзины в день на покупателя" hint="Ответы из кэша и сохранённые ответы специалиста — без лимита.">
            <input type="number" min={0} max={50} step="1" value={form.cart_daily_limit} onChange={(e) => set('cart_daily_limit', Math.round(num(e.target.value)))} />
          </Field>
          <Field label="Сообщений в чате VITALO AI в день на покупателя" hint="Для чата (подэтап 3.9).">
            <input type="number" min={0} max={500} step="1" value={form.chat_daily_limit} onChange={(e) => set('chat_daily_limit', Math.round(num(e.target.value)))} />
          </Field>
          <ErrorBox error={save.error} />
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" disabled={save.isPending} onClick={() => setForm(s.defaults)}>
              По умолчанию
            </button>
            <button className="btn" disabled={save.isPending}>
              Сохранить
            </button>
          </div>
          {save.isSuccess && <p className="muted small">Сохранено.</p>}
        </form>
      </section>

      <section className="card narrow">
        <h2>Расход</h2>
        <p>
          Сегодня: <strong>{usd(s.today.cost_usd)}</strong> · запросов к модели: {s.today.requests}
        </p>
        <p>
          В этом месяце: <strong>{usd(s.month.cost_usd)}</strong> из ${budget} · запросов: {s.month.requests}{' '}
          <Badge tone={used >= 1 ? 'bad' : used >= 0.8 ? 'warn' : 'ok'}>{Math.min(100, Math.round(used * 100))}%</Badge>
        </p>
        <div className="meter" role="meter" aria-label="Бюджет месяца" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(used * 100))}>
          <span style={{ width: `${Math.min(100, used * 100)}%` }} className={used >= 1 ? 'is-bad' : used >= 0.8 ? 'is-warn' : ''} />
        </div>
        <p className="muted small">
          Ответ не показан покупателю (не прошёл проверку, ошибка или нет ответа модели) в этом месяце: {s.month_failed} — такие корзины ушли
          специалисту. Цена модели {s.settings.model}: ${s.models.find((m) => m.id === s.settings.model)?.input ?? '—'} за миллион входных
          токенов, ${s.models.find((m) => m.id === s.settings.model)?.output ?? '—'} за миллион выходных. Месяц и день — по Ташкенту.
        </p>
      </section>
    </>
  );
}
