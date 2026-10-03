import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead, toInt } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { dateTime, money, ROLE } from '../lib/format';

const TABS = { bank: 'Оплата', texts: 'Тексты', tariffs: 'Тарифы доставки', staff: 'Сотрудники' } as const;
type Tab = keyof typeof TABS;

export function Settings() {
  const [params, setParams] = useSearchParams();
  const tab = (Object.keys(TABS).includes(params.get('tab') ?? '') ? params.get('tab') : 'bank') as Tab;
  return (
    <>
      <PageHead title="Настройки">
        <div className="segmented">
          {(Object.keys(TABS) as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'is-on' : ''} onClick={() => setParams({ tab: t }, { replace: true })}>
              {TABS[t]}
            </button>
          ))}
        </div>
      </PageHead>
      {tab === 'bank' && (
        <>
          <CardTransfer />
          <TextsForm fields={['payment_hint']} />
          <h2 className="section-title">Перевод по реквизитам</h2>
          <BankTransfer />
        </>
      )}
      {tab === 'texts' && <TextsForm fields={['product_disclaimer']} />}
      {tab === 'tariffs' && <Tariffs />}
      {tab === 'staff' && <Staff />}
    </>
  );
}

// ---------------------------------------------------------------- bank transfer

interface Bank {
  recipient: string;
  bank_name: string;
  account: string;
  mfo: string;
  inn: string;
  purpose_template: string;
}
const EMPTY_BANK: Bank = { recipient: '', bank_name: '', account: '', mfo: '', inn: '', purpose_template: 'Оплата заказа {order_number}' };

// ---------------------------------------------------------------- card transfer

interface Card {
  card_number: string;
  recipient: string;
}

const isTestValue = (s: string) => /ТЕСТ/i.test(s) || /^8600(0{12})$/.test(s);

function CardTransfer() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'card'], queryFn: () => api<Card>('/staff/settings/card-transfer') });
  const [f, setF] = useState<Card>({ card_number: '', recipient: '' });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) setF({ ...q.data, card_number: q.data.card_number.replace(/(\d{4})(?=\d)/g, '$1 ') });
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<Card>('/staff/settings/card-transfer', { method: 'PUT', body: f }),
    onSuccess: (c) => {
      client.setQueryData(['settings', 'card'], c);
      setSaved(true);
    },
  });
  if (q.isPending) return <Loading />;
  const test = q.data && (isTestValue(q.data.card_number) || isTestValue(q.data.recipient));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form className="card narrow" onSubmit={submit}>
      <h2>Перевод на карту</h2>
      {test && <div className="alert alert-warn">Сейчас здесь ТЕСТОВЫЕ данные — замените их на настоящие перед запуском.</div>}
      <p className="muted">Клиент видит номер карты и имя получателя с кнопкой «Копировать».</p>
      <div className="form-grid">
        <Field label="Номер карты" hint="16 цифр, можно с пробелами">
          <input value={f.card_number} inputMode="numeric" onChange={(e) => (setF({ ...f, card_number: e.target.value }), setSaved(false))} required />
        </Field>
        <Field label="Имя получателя">
          <input value={f.recipient} onChange={(e) => (setF({ ...f, recipient: e.target.value }), setSaved(false))} required />
        </Field>
      </div>
      <ErrorBox error={save.error} />
      {saved && <div className="alert alert-ok">Сохранено</div>}
      <button className="btn" disabled={save.isPending}>
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

function BankTransfer() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'bank'], queryFn: () => api<Bank | null>('/staff/settings/bank-transfer') });
  const [f, setF] = useState<Bank>(EMPTY_BANK);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api<Bank>('/staff/settings/bank-transfer', { method: 'PUT', body: f }),
    onSuccess: (b) => {
      client.setQueryData(['settings', 'bank'], b);
      setSaved(true);
    },
  });
  if (q.isPending) return <Loading />;
  const set = (k: keyof Bank, v: string) => {
    setF({ ...f, [k]: v });
    setSaved(false);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form className="card narrow" onSubmit={submit}>
      <p className="muted">Эти реквизиты клиент видит на экране «Оплата переводом» в Mini App.</p>
      <Field label="Получатель">
        <input value={f.recipient} onChange={(e) => set('recipient', e.target.value)} required />
      </Field>
      <Field label="Банк">
        <input value={f.bank_name} onChange={(e) => set('bank_name', e.target.value)} required />
      </Field>
      <div className="form-grid">
        <Field label="Расчётный счёт" hint="20 цифр">
          <input value={f.account} onChange={(e) => set('account', e.target.value)} inputMode="numeric" required />
        </Field>
        <Field label="МФО" hint="5 цифр">
          <input value={f.mfo} onChange={(e) => set('mfo', e.target.value)} inputMode="numeric" required />
        </Field>
        <Field label="ИНН" hint="9 цифр">
          <input value={f.inn} onChange={(e) => set('inn', e.target.value)} inputMode="numeric" required />
        </Field>
      </div>
      <Field label="Назначение платежа" hint="{order_number} заменится номером заказа">
        <input value={f.purpose_template} onChange={(e) => set('purpose_template', e.target.value)} required />
      </Field>
      <ErrorBox error={save.error} />
      {saved && <div className="alert alert-ok">Сохранено</div>}
      <button className="btn" disabled={save.isPending}>
        Сохранить
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- tariffs

interface Tariff {
  id: string;
  region: { id: string; name_ru: string };
  city: { id: string; name_ru: string } | null;
  tariff_uzs: number;
  free_shipping_threshold_uzs: number;
  status: 'active' | 'disabled';
}
interface Region {
  id: string;
  name_ru: string;
  cities: { id: string; name_ru: string }[];
}

function Tariffs() {
  const q = useQuery({ queryKey: ['settings', 'tariffs'], queryFn: () => api<Tariff[]>('/staff/settings/tariffs') });
  const [edit, setEdit] = useState<Tariff | 'new' | null>(null);
  return (
    <section className="card flush">
      <div className="card-head">
        <p className="muted">Тариф города важнее тарифа региона. Порог — сумма товаров после скидок, с которой доставка бесплатна.</p>
        <button className="btn" onClick={() => setEdit('new')}>
          + Тариф
        </button>
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : (
        <table className="table table-hover">
          <thead>
            <tr>
              <th>Регион</th>
              <th>Город</th>
              <th className="num">Доставка</th>
              <th className="num">Бесплатно от</th>
              <th>Статус</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((t) => (
              <tr key={t.id} className={t.status === 'active' ? '' : 'muted'}>
                <td>{t.region.name_ru}</td>
                <td>{t.city?.name_ru ?? <span className="muted">весь регион</span>}</td>
                <td className="num">{money(t.tariff_uzs)}</td>
                <td className="num">{money(t.free_shipping_threshold_uzs)}</td>
                <td>
                  <Badge tone={t.status === 'active' ? 'ok' : 'neutral'}>{t.status === 'active' ? 'Активен' : 'Выключен'}</Badge>
                </td>
                <td>
                  <button className="btn btn-sm btn-ghost" onClick={() => setEdit(t)}>
                    Изменить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <TariffModal tariff={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </section>
  );
}

function TariffModal({ tariff, onClose }: { tariff: Tariff | null; onClose: () => void }) {
  const client = useQueryClient();
  const regions = useQuery({ queryKey: ['regions'], queryFn: () => api<Region[]>('/delivery/regions') });
  const [f, setF] = useState({
    region_id: tariff?.region.id ?? '',
    city_id: tariff?.city?.id ?? '',
    tariff_uzs: tariff ? String(tariff.tariff_uzs) : '',
    free_shipping_threshold_uzs: tariff ? String(tariff.free_shipping_threshold_uzs) : '',
    status: tariff?.status ?? 'active',
  });
  const m = useMutation({
    mutationFn: () => {
      const body = {
        region_id: f.region_id,
        city_id: f.city_id || null,
        tariff_uzs: toInt(f.tariff_uzs),
        free_shipping_threshold_uzs: toInt(f.free_shipping_threshold_uzs),
        status: f.status,
      };
      return tariff ? api(`/staff/settings/tariffs/${tariff.id}`, { method: 'PATCH', body }) : api('/staff/settings/tariffs', { method: 'POST', body });
    },
    onSuccess: (list) => {
      client.setQueryData(['settings', 'tariffs'], list);
      onClose();
    },
  });
  const region = regions.data?.find((r) => r.id === f.region_id);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };

  return (
    <Modal title={tariff ? 'Изменить тариф' : 'Новый тариф'} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Регион">
            <select value={f.region_id} onChange={(e) => setF({ ...f, region_id: e.target.value, city_id: '' })} required>
              <option value="">—</option>
              {regions.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name_ru}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Город" hint="Пусто — для всего региона">
            <select value={f.city_id} onChange={(e) => setF({ ...f, city_id: e.target.value })}>
              <option value="">Весь регион</option>
              {region?.cities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_ru}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Стоимость доставки, сум">
            <input inputMode="numeric" value={f.tariff_uzs} onChange={(e) => setF({ ...f, tariff_uzs: e.target.value })} required />
          </Field>
          <Field label="Бесплатно от, сум">
            <input inputMode="numeric" value={f.free_shipping_threshold_uzs} onChange={(e) => setF({ ...f, free_shipping_threshold_uzs: e.target.value })} required />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.status === 'active'} onChange={(e) => setF({ ...f, status: e.target.checked ? 'active' : 'disabled' })} />
          Активен
        </label>
        <ErrorBox error={m.error} />
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn" disabled={m.isPending}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- staff

interface StaffRow {
  id: string;
  telegram_user_id: number;
  name: string;
  role: string;
  status: 'active' | 'blocked';
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
    mutationFn: ({ id, ...body }: { id: string; role?: string; status?: string }) => api<StaffRow[]>(`/staff/users/${id}`, { method: 'PATCH', body }),
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
