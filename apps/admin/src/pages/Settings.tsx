import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { useTab } from '../lib/useTab';
import { dateTime, ROLE } from '../lib/format';
import { CheckoutOptions } from './settings/CheckoutOptions';
import { ContactsForm } from './settings/Contacts';
import { PaymentTimeouts } from './settings/PaymentTimeouts';
import { DeliverySettings } from './settings/Delivery';
import { DictionariesSettings } from './settings/Dictionaries';
import { LabelSizeSettings } from './settings/LabelSize';
import { LegalSettings } from './settings/Legal';
import { VitaloAiSettings } from './settings/VitaloAi';

const TABS = { bank: 'Оплата', texts: 'Тексты и контакты', tariffs: 'Доставка', dicts: 'Справочники', print: 'Печать', docs: 'Документы', ai: 'VITALO AI', staff: 'Сотрудники' } as const;
type Tab = keyof typeof TABS;

export function Settings() {
  const [tab, setTab] = useTab(Object.keys(TABS) as Tab[], 'bank');
  return (
    <>
      <PageHead title="Настройки">
        <div className="segmented segmented-wrap">
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'is-on' : ''} onClick={() => setTab(t)}>
              {TABS[t]}
            </button>
          ))}
        </div>
      </PageHead>
      {tab === 'bank' && (
        <>
          <CheckoutOptions />
          <PaymentTimeouts />
          <CardTransfer />
          <TextsForm fields={['payment_hint']} />
        </>
      )}
      {tab === 'texts' && (
        <>
          <ContactsForm />
          <TextsForm fields={['product_disclaimer']} />
        </>
      )}
      {tab === 'tariffs' && <DeliverySettings />}
      {tab === 'dicts' && <DictionariesSettings />}
      {tab === 'print' && <LabelSizeSettings />}
      {tab === 'docs' && <LegalSettings />}
      {tab === 'ai' && <VitaloAiSettings />}
      {tab === 'staff' && <Staff />}
    </>
  );
}

// ---------------------------------------------------------------- card transfer

interface Card {
  card_number: string;
}

const isTestValue = (s: string) => /ТЕСТ/i.test(s) || /^8600(0{12})$/.test(s);

function CardTransfer() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'card'], queryFn: () => api<Card>('/staff/settings/card-transfer') });
  const [f, setF] = useState<Card>({ card_number: '' });
  const [saved, setSaved] = useState(false);
  // D-65 / аудит 4.8: a new number only with the code from the bot; every admin gets a message about the change
  const [code, setCode] = useState('');
  useEffect(() => {
    if (q.data) setF({ card_number: q.data.card_number.replace(/(\d{4})(?=\d)/g, '$1 ') });
  }, [q.data]);
  const changed = !!q.data && f.card_number.replace(/\s/g, '') !== q.data.card_number;
  const sendCode = useMutation({ mutationFn: () => api<{ sent: boolean }>('/staff/settings/card-transfer/code', { method: 'POST' }) });
  const save = useMutation({
    mutationFn: () => api<Card>('/staff/settings/card-transfer', { method: 'PUT', body: { ...f, ...(changed && { code }) } }),
    onSuccess: (c) => {
      client.setQueryData(['settings', 'card'], c);
      setSaved(true);
      setCode('');
      sendCode.reset();
    },
  });
  if (q.isPending) return <Loading />;
  const test = q.data && isTestValue(q.data.card_number);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form className="card narrow" onSubmit={submit}>
      <h2>Перевод на карту</h2>
      {test && <div className="alert alert-warn">Сейчас здесь ТЕСТОВЫЕ данные — замените их на настоящие перед запуском.</div>}
      <p className="muted">Клиент видит только номер карты — его можно скопировать одним нажатием. Имя владельца карты не показывается и не сохраняется.</p>
      <div className="form-grid">
        <Field label="Номер карты" hint="16 цифр, можно с пробелами">
          <input value={f.card_number} inputMode="numeric" onChange={(e) => (setF({ ...f, card_number: e.target.value }), setSaved(false))} required />
        </Field>
      </div>
      {changed && (
        <div className="card-code">
          <p className="small">
            Новый номер сохраняется только с кодом: он придёт вам в Telegram от бота. После смены все администраторы получат сообщение.
          </p>
          <div className="row">
            <button type="button" className="btn btn-ghost btn-sm" disabled={sendCode.isPending} onClick={() => sendCode.mutate()}>
              {sendCode.isSuccess ? 'Отправить код ещё раз' : 'Получить код'}
            </button>
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" placeholder="Код из бота" aria-label="Код из бота" className="input-sm" />
          </div>
          {sendCode.isSuccess && <p className="muted small">Код отправлен, действует 10 минут.</p>}
          <ErrorBox error={sendCode.error} />
        </div>
      )}
      <ErrorBox error={save.error} />
      {saved && <div className="alert alert-ok">Сохранено</div>}
      <button className="btn" disabled={save.isPending || (changed && code.length !== 6)}>
        Сохранить
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- customer-facing texts (RU/UZ)

type TextKey = 'product_disclaimer' | 'payment_hint';
type Texts = Record<TextKey, { ru: string; uz: string }>;
const TEXT_INFO: Record<TextKey, { title: string; hint: string }> = {
  payment_hint: { title: 'Подсказка на экране оплаты', hint: 'Показывается клиенту под реквизитами или номером карты.' },
  product_disclaimer: { title: 'Пометка на карточке товара', hint: 'Всегда видна внизу карточки товара в магазине.' },
};

/** Edits some of the texts; the others are sent back unchanged (the API saves both at once). */
function TextsForm({ fields }: { fields: TextKey[] }) {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'texts'], queryFn: () => api<Texts>('/staff/settings/texts') });
  const [f, setF] = useState<Texts | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<Texts>('/staff/settings/texts', { method: 'PUT', body: { ...q.data, ...Object.fromEntries(fields.map((k) => [k, f![k]])) } }),
    onSuccess: (t) => {
      client.setQueryData(['settings', 'texts'], t);
      setSaved(true);
    },
  });
  if (q.isPending || !f) return <Loading />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const set = (k: TextKey, lang: 'ru' | 'uz', v: string) => {
    setF({ ...f, [k]: { ...f[k], [lang]: v } });
    setSaved(false);
  };

  return (
    <form className="card narrow" onSubmit={submit}>
      {fields.map((k) => (
        <div key={k}>
          <h2>{TEXT_INFO[k].title}</h2>
          <p className="muted">{TEXT_INFO[k].hint}</p>
          <Field label="Русский">
            <textarea rows={3} value={f[k].ru} onChange={(e) => set(k, 'ru', e.target.value)} required />
          </Field>
          <Field label="O‘zbekcha">
            <textarea rows={3} value={f[k].uz} onChange={(e) => set(k, 'uz', e.target.value)} required />
          </Field>
        </div>
      ))}
      <ErrorBox error={save.error} />
      {saved && <div className="alert alert-ok">Сохранено</div>}
      <button className="btn" disabled={save.isPending}>
        Сохранить
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- tariffs

// ---------------------------------------------------------------- staff

interface StaffRow {
  id: string;
  telegram_user_id: number;
  name: string;
  role: string;
  status: 'active' | 'blocked';
  is_specialist: boolean;
  active_sessions: number;
  created_at: string;
}

function Staff() {
  const { staff: me } = useSession();
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'staff'], queryFn: () => api<StaffRow[]>('/staff/users') });
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; role?: string; status?: string; is_specialist?: boolean }) => api<StaffRow[]>(`/staff/users/${id}`, { method: 'PATCH', body }),
    onSuccess: (list) => client.setQueryData(['settings', 'staff'], list),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api<{ revoked: number }>(`/staff/users/${id}/revoke-sessions`, { method: 'POST' }),
    onSuccess: (r) => {
      setNotice(`Отозвано сессий: ${r.revoked}`);
      void client.invalidateQueries({ queryKey: ['settings', 'staff'] });
    },
  });

  return (
    <section className="card flush">
      <div className="card-head">
        <p className="muted">Сотрудник входит через Telegram. Смена роли или блокировка сразу завершает его сессии.</p>
        <button className="btn" onClick={() => setAdding(true)}>
          + Сотрудник
        </button>
      </div>
      <ErrorBox error={update.error ?? revoke.error} />
      {notice && <div className="alert alert-ok">{notice}</div>}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Сотрудник</th>
              <th>Telegram ID</th>
              <th>Роль</th>
              <th>Статус</th>
              <th title="Отвечает на запросы «Проверить совместимость» и видит комментарий клиента">Специалист</th>
              <th className="num">Активных сессий</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((s) => {
              const self = s.id === me.id;
              return (
                <tr key={s.id}>
                  <td>
                    {s.name} {self && <span className="muted small">(вы)</span>}
                    <div className="muted small">с {dateTime(s.created_at)}</div>
                  </td>
                  <td>{s.telegram_user_id}</td>
                  <td>
                    <select value={s.role} disabled={self || update.isPending} onChange={(e) => update.mutate({ id: s.id, role: e.target.value })} aria-label="Роль">
                      {Object.entries(ROLE).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <Badge tone={s.status === 'active' ? 'ok' : 'bad'}>{s.status === 'active' ? 'Активен' : 'Заблокирован'}</Badge>
                  </td>
                  <td>
                    {/* 3.4: answers «Проверить совместимость» (an admin answers anyway) */}
                    <label className="check">
                      <input type="checkbox" checked={s.role === 'admin' || s.is_specialist} disabled={s.role === 'admin' || update.isPending} onChange={(e) => update.mutate({ id: s.id, is_specialist: e.target.checked })} aria-label="Специалист" />
                    </label>
                  </td>
                  <td className="num">{s.active_sessions}</td>
                  <td className="ops">
                    {!self && (
                      <button className="btn btn-sm btn-ghost" onClick={() => update.mutate({ id: s.id, status: s.status === 'active' ? 'blocked' : 'active' })}>
                        {s.status === 'active' ? 'Заблокировать' : 'Разблокировать'}
                      </button>
                    )}
                    <button className="btn btn-sm btn-ghost" disabled={!s.active_sessions} onClick={() => revoke.mutate(s.id)}>
                      Отозвать сессии
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {adding && <AddStaff onClose={() => setAdding(false)} />}
    </section>
  );
}

function AddStaff({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const [f, setF] = useState({ telegram_user_id: '', name: '', role: 'manager' });
  const m = useMutation({
    mutationFn: () => api<StaffRow[]>('/staff/users', { method: 'POST', body: f }),
    onSuccess: (list) => {
      client.setQueryData(['settings', 'staff'], list);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <Modal title="Новый сотрудник" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Telegram ID" hint="Числовой ID (узнать можно у бота @userinfobot)">
          <input inputMode="numeric" value={f.telegram_user_id} onChange={(e) => setF({ ...f, telegram_user_id: e.target.value })} required />
        </Field>
        <Field label="Имя">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        </Field>
        <Field label="Роль">
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            {Object.entries(ROLE).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <ErrorBox error={m.error} />
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn" disabled={m.isPending}>
            Добавить
          </button>
        </div>
      </form>
    </Modal>
  );
}
