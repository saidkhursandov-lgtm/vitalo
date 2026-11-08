import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, ErrorBox, Loading, PageHead } from '../components/ui';
import { api, errorText } from '../lib/api';
import { useSession } from '../lib/auth';
import { dateTime } from '../lib/format';

export interface StaffSession {
  id: string;
  kind: 'telegram' | 'web' | 'backup';
  device_name: string;
  ip: string | null;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string;
  current: boolean;
}

const KIND: Record<StaffSession['kind'], string> = { telegram: 'Telegram', web: 'Браузер', backup: 'Резервный код' };

/**
 * Генплан, этап 3 (D-56): where I am signed in. «Выйти» ends one session (its browser must be confirmed in the
 * bot again); «Выйти везде» ends all of them, this one too. The owner also manages backup codes here.
 */
export function Devices() {
  const { can, logout } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['staff-sessions'], queryFn: () => api<StaffSession[]>('/staff/auth/sessions') });
  const [error, setError] = useState<string | null>(null);

  const revoke = useMutation({
    mutationFn: (s: StaffSession) => api(`/staff/auth/sessions/${s.id}`, { method: 'DELETE' }).then(() => s),
    onSuccess: (s) => (s.current ? void logout() : void qc.invalidateQueries({ queryKey: ['staff-sessions'] })),
    onError: (e) => setError(errorText(e)),
  });
  const everywhere = useMutation({
    mutationFn: () => api('/staff/auth/logout-everywhere', { method: 'POST' }),
    onSuccess: () => void logout(),
    onError: (e) => setError(errorText(e)),
  });

  return (
    <>
      <PageHead title="Мои устройства">
        <button
          className="btn btn-danger"
          disabled={everywhere.isPending}
          onClick={() => window.confirm('Выйти на всех устройствах, включая это? Новые браузеры придётся снова подтвердить в боте.') && everywhere.mutate()}
        >
          Выйти везде
        </button>
      </PageHead>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="card">
        <p className="muted small" style={{ marginTop: 0 }}>
          Где открыта ваша админка. Незнакомое устройство — нажмите «Выйти» и сообщите администратору.
        </p>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Устройство</th>
                  <th>Вход</th>
                  <th>Последняя активность</th>
                  <th>IP</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {q.data!.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.device_name} {s.current && <Badge tone="ok">Это устройство</Badge>}
                      {KIND[s.kind] !== s.device_name && <div className="muted small">{KIND[s.kind]}</div>}
                    </td>
                    <td>{dateTime(s.created_at)}</td>
                    <td>{dateTime(s.last_seen_at)}</td>
                    <td>{s.ip ?? '—'}</td>
                    <td className="num">
                      <button className="btn btn-sm btn-ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(s)}>
                        Выйти
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {can('staff.manage') && <BackupCodes />}
    </>
  );
}

/** The owner's emergency entry: 10 one-time codes, shown once. */
export function BackupCodes() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['backup-codes'], queryFn: () => api<{ total: number; left: number; created_at: string | null }>('/staff/auth/backup-codes') });
  const [codes, setCodes] = useState<string[] | null>(null);
  const make = useMutation({
    mutationFn: () => api<{ codes: string[] }>('/staff/auth/backup-codes', { method: 'POST' }),
    onSuccess: (r) => {
      setCodes(r.codes);
      void qc.invalidateQueries({ queryKey: ['backup-codes'] });
    },
  });
  const ask = () =>
    (!q.data?.left || window.confirm('Создать новые коды? Старые неиспользованные коды перестанут работать.')) && make.mutate();

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Резервные коды</h2>
      <p className="muted small">
        Аварийный вход, если Telegram или бот VITALO недоступны: на странице входа — «Войти по резервному коду». Каждый код работает один раз, о каждом входе
        администраторы получают сообщение. Храните коды отдельно от телефона, как ключи от магазина.
      </p>
      {q.data && (
        <p>
          {q.data.left > 0 ? `Осталось кодов: ${q.data.left} из ${q.data.total}` : 'Кодов нет — создайте их сейчас, пока всё работает.'}
          {q.data.left > 0 && q.data.left <= 3 && <> <Badge tone="warn">мало</Badge></>}
        </p>
      )}
      {codes && (
        <div className="alert alert-warn" style={{ display: 'block' }}>
          <strong>Запишите или распечатайте коды сейчас — больше они не покажутся.</strong>
          <ol className="backup-codes">
            {codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ol>
          <button className="btn btn-sm btn-ghost" onClick={() => window.print()}>
            Распечатать
          </button>{' '}
          <button className="btn btn-sm btn-ghost" onClick={() => setCodes(null)}>
            Я записал(а) коды
          </button>
        </div>
      )}
      {make.error && <div className="alert alert-error">{errorText(make.error)}</div>}
      {!codes && (
        <button className="btn" disabled={make.isPending} onClick={ask}>
          {q.data?.left ? 'Создать новые коды' : 'Создать коды'}
        </button>
      )}
    </div>
  );
}
