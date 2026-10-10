import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, ErrorBox, Field, Loading, Modal, PageHead, toInt } from '../components/ui';
import { api, qs } from '../lib/api';
import { money, ruDate } from '../lib/format';
import { monthRange } from './Analytics';

/** Stage 3 «Финансы» (admin only): «Расходы», «Налог», «Сотрудники и зарплаты». Every change is audited by the server. */

const TABS = [
  ['expenses', 'Расходы'],
  ['tax', 'Налог'],
  ['payroll', 'Сотрудники и зарплаты'],
] as const;
type Tab = (typeof TABS)[number][0];

const tashkentToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
/** «2026-11» -> «ноябрь 2026» */
export const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const validSum = (v: string, min = 0) => {
  const n = toInt(v);
  return n !== undefined && Number.isInteger(n) && n >= min ? n : null;
};
const STATUS: Record<'paid' | 'due' | 'overdue', [string, 'ok' | 'warn' | 'bad']> = { paid: ['оплачено', 'ok'], due: ['к оплате', 'warn'], overdue: ['просрочено', 'bad'] };
const PAY_STATUS: Record<'paid' | 'due' | 'overdue', string> = { paid: 'выплачено', due: 'к выплате', overdue: 'просрочено' };

export function Finance() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([t]) => t === params.get('tab'))?.[0] ?? 'expenses') as Tab;
  return (
    <>
      <PageHead title="Финансы">
        <div className="segmented">
          {TABS.map(([t, label]) => (
            <button key={t} className={tab === t ? 'is-on' : ''} onClick={() => setParams(t === 'expenses' ? {} : { tab: t }, { replace: true })}>
              {label}
            </button>
          ))}
        </div>
      </PageHead>
      {tab === 'expenses' ? <Expenses /> : tab === 'tax' ? <Tax /> : <Payroll />}
    </>
  );
}

// ====================================================================== expenses

interface Category {
  id: string;
  name: string;
  hidden: boolean;
  expenses: number;
}
interface Expense {
  id: string;
  spent_on: string;
  category_id: string;
  category: string;
  amount_uzs: number;
  comment: string | null;
}
interface ExpenseList {
  items: Expense[];
  total_uzs: number;
  by_category: { category: string; amount_uzs: number }[];
}

function Expenses() {
  const client = useQueryClient();
  const [f, setF] = useState({ ...monthRange(tashkentToday(), 0), category_id: '' });
  const [edit, setEdit] = useState<Expense | 'new' | null>(null);
  const [del, setDel] = useState<Expense | null>(null);
  const [cats, setCats] = useState(false);
  const categories = useQuery({ queryKey: ['expense-categories'], queryFn: () => api<Category[]>('/staff/finance/expense-categories') });
  const list = useQuery({ queryKey: ['expenses', f], queryFn: () => api<ExpenseList>(`/staff/finance/expenses${qs(f)}`) });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['expenses'] });
    void client.invalidateQueries({ queryKey: ['expense-categories'] });
    void client.invalidateQueries({ queryKey: ['analytics'] });
  };
  if (categories.isPending || list.isPending) return <Loading />;
  if (categories.isError) return <ErrorBox error={categories.error} onRetry={() => void categories.refetch()} />;
  if (list.isError) return <ErrorBox error={list.error} onRetry={() => void list.refetch()} />;
  return (
    <>
      <div className="filters">
        <label className="muted small">
          с <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="Расходы с" />
        </label>
        <label className="muted small">
          по <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="Расходы по" />
        </label>
        <select value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })} aria-label="Категория">
          <option value="">Все категории</option>
          {categories.data.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.hidden ? ' (скрыта)' : ''}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => setEdit('new')}>
          Добавить расход
        </button>
        <button className="btn btn-ghost" onClick={() => setCats(true)}>
          Категории
        </button>
      </div>
      <section className="card flush">
        <table className="table table-hover">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Категория</th>
              <th>Комментарий</th>
              <th className="num">Сумма</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.items.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  За период расходов нет
                </td>
              </tr>
            )}
            {list.data.items.map((e) => (
              <tr key={e.id}>
                <td>{ruDate(e.spent_on)}</td>
                <td>{e.category}</td>
                <td>{e.comment ?? <span className="muted">—</span>}</td>
                <td className="num">{money(e.amount_uzs)}</td>
                <td className="num">
                  <button className="btn btn-sm btn-ghost" onClick={() => setEdit(e)}>
                    Изменить
                  </button>{' '}
                  <button className="btn btn-sm btn-ghost" onClick={() => setDel(e)}>
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="table-foot">
          <span className="strong">Итого за период: {money(list.data.total_uzs)}</span>
          <span className="muted small">{list.data.by_category.map((c) => `${c.category}: ${money(c.amount_uzs)}`).join(' · ')}</span>
        </div>
      </section>
      {edit && (
        <ExpenseModal
          expense={edit === 'new' ? null : edit}
          categories={categories.data}
          onClose={() => setEdit(null)}
          onDone={() => {
            setEdit(null);
            refresh();
          }}
        />
      )}
      {del && (
        <DeleteExpenseModal
          expense={del}
          onClose={() => setDel(null)}
          onDone={() => {
            setDel(null);
            refresh();
          }}
        />
      )}
      {cats && <CategoriesModal categories={categories.data} onClose={() => setCats(false)} onDone={refresh} />}
    </>
  );
}

function ExpenseModal({ expense, categories, onClose, onDone }: { expense: Expense | null; categories: Category[]; onClose: () => void; onDone: () => void }) {
  const visible = categories.filter((c) => !c.hidden || c.id === expense?.category_id);
  const [form, setForm] = useState({ spent_on: expense?.spent_on ?? tashkentToday(), category_id: expense?.category_id ?? visible[0]?.id ?? '', amount: expense ? String(expense.amount_uzs) : '', comment: expense?.comment ?? '' });
  const amount = validSum(form.amount, 1);
  const save = useMutation({
    mutationFn: () =>
      api(expense ? `/staff/finance/expenses/${expense.id}` : '/staff/finance/expenses', {
        method: expense ? 'PATCH' : 'POST',
        body: { spent_on: form.spent_on, category_id: form.category_id, amount_uzs: amount, comment: form.comment.trim() || null },
      }),
    onSuccess: onDone,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (amount !== null && form.category_id) save.mutate();
  };
  return (
    <Modal title={expense ? 'Изменить расход' : 'Новый расход'} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={save.error} />
        <Field label="Дата">
          <input type="date" value={form.spent_on} onChange={(e) => setForm({ ...form, spent_on: e.target.value })} required />
        </Field>
        <Field label="Категория">
          <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })} required>
            {visible.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Сумма, сум" hint="Целое число больше нуля">
          <input inputMode="numeric" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} autoFocus required />
        </Field>
        <Field label="Комментарий">
          <input value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} maxLength={500} />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn" disabled={amount === null || !form.category_id || save.isPending}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteExpenseModal({ expense, onClose, onDone }: { expense: Expense; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const del = useMutation({ mutationFn: () => api(`/staff/finance/expenses/${expense.id}/delete`, { method: 'POST', body: { reason: reason.trim() } }), onSuccess: onDone });
  return (
    <Modal title="Удалить расход" onClose={onClose}>
      <p>
        {ruDate(expense.spent_on)}, {expense.category}, {money(expense.amount_uzs)}
      </p>
      <ErrorBox error={del.error} />
      <Field label="Причина удаления" hint="Не короче 3 символов; запись остаётся в журнале">
        <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button className="btn btn-danger" disabled={reason.trim().length < 3 || del.isPending} onClick={() => del.mutate()}>
          Удалить
        </button>
      </div>
    </Modal>
  );
}

function CategoriesModal({ categories, onClose, onDone }: { categories: Category[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const act = useMutation({
    mutationFn: (a: { method: string; path: string; body?: object }) => api(`/staff/finance/expense-categories${a.path}`, { method: a.method, body: a.body }),
    onSuccess: () => {
      setName('');
      setRenaming(null);
      onDone();
    },
  });
  return (
    <Modal title="Категории расходов" onClose={onClose}>
      <ErrorBox error={act.error} />
      <table className="table">
        <tbody>
          {categories.map((c) => (
            <tr key={c.id}>
              <td>
                {renaming?.id === c.id ? (
                  <input value={renaming.name} onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} aria-label="Новое название" autoFocus />
                ) : (
                  <>
                    {c.name} {c.hidden && <Badge>скрыта</Badge>} <span className="muted small">записей: {c.expenses}</span>
                  </>
                )}
              </td>
              <td className="num">
                {renaming?.id === c.id ? (
                  <button className="btn btn-sm" disabled={!renaming.name.trim() || act.isPending} onClick={() => act.mutate({ method: 'PATCH', path: `/${c.id}`, body: { name: renaming.name.trim() } })}>
                    Сохранить
                  </button>
                ) : (
                  <>
                    <button className="btn btn-sm btn-ghost" onClick={() => setRenaming({ id: c.id, name: c.name })}>
                      Переименовать
                    </button>{' '}
                    <button className="btn btn-sm btn-ghost" disabled={act.isPending} onClick={() => act.mutate({ method: 'PATCH', path: `/${c.id}`, body: { hidden: !c.hidden } })}>
                      {c.hidden ? 'Показать' : 'Скрыть'}
                    </button>{' '}
                    {c.expenses === 0 && (
                      <button className="btn btn-sm btn-ghost" disabled={act.isPending} onClick={() => act.mutate({ method: 'DELETE', path: `/${c.id}` })}>
                        Удалить
                      </button>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Категорию с записями удалить нельзя — только скрыть: она пропадёт из списка при добавлении расхода.</p>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) act.mutate({ method: 'POST', path: '', body: { name: name.trim() } });
        }}
      >
        <input placeholder="Новая категория" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <button className="btn" disabled={!name.trim() || act.isPending}>
          Добавить
        </button>
      </form>
    </Modal>
  );
}

// ====================================================================== tax

interface TaxMonth {
  month: string;
  turnover_uzs: number;
  turnover_yandex_uzs: number;
  turnover_vitalo_uzs: number;
  rate_percent: number;
  tax_uzs: number;
  due_day: string;
  closed: boolean;
  status: 'paid' | 'due' | 'overdue';
  payment: { paid_on: string; paid_amount_uzs: number; tax_at_payment_uzs: number; difference_uzs: number } | null;
}
interface TaxData {
  rates: { from: string; value: number }[];
  months: TaxMonth[];
}

function Tax() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['tax'], queryFn: () => api<TaxData>('/staff/finance/tax') });
  const [pay, setPay] = useState<TaxMonth | null>(null);
  const [rate, setRate] = useState(false);
  const [all, setAll] = useState(false);
  const done = (data: TaxData) => {
    client.setQueryData(['tax'], data);
    void client.invalidateQueries({ queryKey: ['analytics'] });
    setPay(null);
    setRate(false);
  };
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  // months without any turnover or payment are noise (the list starts with the very first sale)
  const rows = q.data.months.filter((m) => all || !m.closed || m.turnover_uzs !== 0 || m.payment);
  const current = q.data.rates[q.data.rates.length - 1];
  return (
    <>
      <section className="card">
        <dl className="props">
          <dt>Ставка налога с оборота</dt>
          <dd>
            {q.data.rates.map((r, i) => (
              <div key={r.from}>
                {r.value}% {i === 0 ? '(с начала)' : `с ${monthName(r.from)}`}
              </div>
            ))}
            <button className="btn btn-sm btn-ghost" onClick={() => setRate(true)}>
              Изменить ставку
            </button>
          </dd>
          <dt>Как считается</dt>
          <dd className="muted small">
            Оборот месяца = цены товаров в заказах, ставших «Доставлен» в этом месяце, минус возвраты, оформленные в этом месяце. Без тестовых заказов и без доставки, оплаченной клиентом. Срок оплаты — до 14-го числа следующего
            месяца.
          </dd>
        </dl>
      </section>
      <section className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>Месяц</th>
              <th className="num">Оборот</th>
              <th className="num">Ставка</th>
              <th className="num">К уплате</th>
              <th>Срок</th>
              <th>Статус</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.month}>
                <td className="strong">{monthName(m.month)}</td>
                <td className="num">
                  {money(m.turnover_uzs)}
                  <div className="muted small">
                    Яндекс {money(m.turnover_yandex_uzs)} · VITALO {money(m.turnover_vitalo_uzs)}
                  </div>
                </td>
                <td className="num">{m.rate_percent}%</td>
                <td className="num">{money(m.tax_uzs)}</td>
                <td>до {ruDate(m.due_day)}</td>
                <td>
                  {!m.closed ? (
                    <Badge>месяц идёт</Badge>
                  ) : m.payment ? (
                    <>
                      <Badge tone="ok">оплачено</Badge>
                      <div className="muted small">
                        {ruDate(m.payment.paid_on)}, {money(m.payment.paid_amount_uzs)}
                      </div>
                      {m.payment.difference_uzs !== 0 && (
                        <div className="text-warn small">
                          После оплаты расчёт изменился: было {money(m.payment.tax_at_payment_uzs)}, стало {money(m.tax_uzs)} (разница {money(m.payment.difference_uzs)}). Запись об оплате не меняется.
                        </div>
                      )}
                    </>
                  ) : m.tax_uzs === 0 ? (
                    <span className="muted">нечего платить</span>
                  ) : (
                    <Badge tone={STATUS[m.status][1]}>{STATUS[m.status][0]}</Badge>
                  )}
                </td>
                <td className="num">
                  {m.closed && !m.payment && m.tax_uzs > 0 && (
                    <button className="btn btn-sm" onClick={() => setPay(m)}>
                      Отметить оплаченным
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="table-foot">
          <label className="check">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Показывать месяцы без оборота
          </label>
        </div>
      </section>
      {pay && <PayModal title={`Налог за ${monthName(pay.month)}`} amount={pay.tax_uzs} path={`/staff/finance/tax/${pay.month}/pay`} bodyOf={(paid_on, amount) => ({ paid_on, paid_amount_uzs: amount })} onClose={() => setPay(null)} onDone={(d) => done(d as TaxData)} />}
      {rate && <RateModal current={current.value} onClose={() => setRate(false)} onDone={done} />}
    </>
  );
}

function RateModal({ current, onClose, onDone }: { current: number; onClose: () => void; onDone: (d: TaxData) => void }) {
  const thisMonth = tashkentToday().slice(0, 7);
  const [percent, setPercent] = useState(String(current));
  const [from, setFrom] = useState(thisMonth);
  const value = Number(percent.replace(',', '.'));
  const valid = percent.trim() !== '' && Number.isFinite(value) && value >= 0 && value < 100 && from >= thisMonth;
  const save = useMutation({ mutationFn: () => api<TaxData>('/staff/finance/tax/rate', { method: 'POST', body: { from_month: from, percent: value } }), onSuccess: onDone });
  return (
    <Modal title="Ставка налога" onClose={onClose}>
      <ErrorBox error={save.error} />
      <Field label="Ставка, %">
        <input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} autoFocus />
      </Field>
      <Field label="Действует с месяца" hint="Только текущий или будущий месяц: прошлые месяцы не пересчитываются">
        <input type="month" value={from} min={thisMonth} onChange={(e) => setFrom(e.target.value)} />
      </Field>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button className="btn" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          Сохранить
        </button>
      </div>
    </Modal>
  );
}

/** «Отметить оплаченным / выплаченной»: the date and the amount really paid. */
function PayModal({ title, amount, path, bodyOf, onClose, onDone }: { title: string; amount: number; path: string; bodyOf: (paidOn: string, amount: number) => object; onClose: () => void; onDone: (data: unknown) => void }) {
  const [paidOn, setPaidOn] = useState(tashkentToday());
  const [sum, setSum] = useState(String(amount));
  const value = validSum(sum);
  const save = useMutation({ mutationFn: () => api<unknown>(path, { method: 'POST', body: bodyOf(paidOn, value ?? 0) }), onSuccess: onDone });
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted">По расчёту: {money(amount)}</p>
      <ErrorBox error={save.error} />
      <Field label="Дата оплаты">
        <input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} required />
      </Field>
      <Field label="Фактическая сумма, сум">
        <input inputMode="numeric" value={sum} onChange={(e) => setSum(e.target.value)} />
      </Field>
      <p className="muted small">После отметки запись не меняется.</p>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button className="btn" disabled={value === null || !paidOn || save.isPending} onClick={() => save.mutate()}>
          Отметить
        </button>
      </div>
    </Modal>
  );
}

// ====================================================================== payroll

interface PayMonth {
  month: string;
  amount_uzs: number;
  due_day: string;
  status: 'paid' | 'due' | 'overdue';
  payment: { paid_on: string; amount_uzs: number } | null;
}
interface Employee {
  id: string;
  name: string;
  start_month: string;
  end_month: string | null;
  active: boolean;
  amount_uzs: number;
  rates: { from_month: string; amount_uzs: number }[];
  months: PayMonth[];
}
interface PayrollData {
  employees: Employee[];
}

function Payroll() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['payroll'], queryFn: () => api<PayrollData>('/staff/finance/payroll') });
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState<Employee | null>(null);
  const [pay, setPay] = useState<{ e: Employee; m: PayMonth } | null>(null);
  const done = (data: PayrollData) => {
    client.setQueryData(['payroll'], data);
    void client.invalidateQueries({ queryKey: ['analytics'] });
    setAdd(false);
    setEdit(null);
    setPay(null);
  };
  const toggle = useMutation({ mutationFn: (e: Employee) => api<PayrollData>(`/staff/finance/payroll/employees/${e.id}`, { method: 'PATCH', body: { active: !e.active } }), onSuccess: done });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const accruals = q.data.employees.flatMap((e) => e.months.map((m) => ({ e, m }))).sort((a, b) => b.m.month.localeCompare(a.m.month) || a.e.name.localeCompare(b.e.name));
  return (
    <>
      <ErrorBox error={toggle.error} />
      <section className="card flush">
        <div className="card-head" style={{ padding: '14px 18px' }}>
          <h2>Сотрудники</h2>
          <button className="btn btn-sm" onClick={() => setAdd(true)}>
            Добавить сотрудника
          </button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Имя</th>
              <th className="num">Сумма в месяц</th>
              <th>Начисляется с</th>
              <th>Статус</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.employees.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Сотрудников пока нет. Добавьте имя, сумму и месяц начала.
                </td>
              </tr>
            )}
            {q.data.employees.map((e) => (
              <tr key={e.id}>
                <td className="strong">{e.name}</td>
                <td className="num">
                  {money(e.amount_uzs)}
                  {e.rates.length > 1 && <div className="muted small">{e.rates.map((r) => `с ${monthName(r.from_month)}: ${money(r.amount_uzs)}`).join('; ')}</div>}
                </td>
                <td>{monthName(e.start_month)}</td>
                <td>{e.active ? <Badge tone="ok">активен</Badge> : <Badge>не активен{e.end_month ? `, последний месяц — ${monthName(e.end_month)}` : ''}</Badge>}</td>
                <td className="num">
                  <button className="btn btn-sm btn-ghost" onClick={() => setEdit(e)}>
                    Изменить
                  </button>{' '}
                  <button className="btn btn-sm btn-ghost" disabled={toggle.isPending} onClick={() => toggle.mutate(e)}>
                    {e.active ? 'Отключить' : 'Включить'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card flush">
        <div className="card-head" style={{ padding: '14px 18px' }}>
          <h2>Начисления</h2>
          <span className="muted small">Зарплата за месяц выплачивается до 14-го числа следующего месяца</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Месяц</th>
              <th>Сотрудник</th>
              <th className="num">Начислено</th>
              <th>Срок</th>
              <th>Статус</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {accruals.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Начислений пока нет: они появляются с месяца начала работы сотрудника.
                </td>
              </tr>
            )}
            {accruals.map(({ e, m }) => (
              <tr key={`${e.id}|${m.month}`}>
                <td className="strong">{monthName(m.month)}</td>
                <td>{e.name}</td>
                <td className="num">{money(m.amount_uzs)}</td>
                <td>до {ruDate(m.due_day)}</td>
                <td>
                  <Badge tone={STATUS[m.status][1]}>{PAY_STATUS[m.status]}</Badge>
                  {m.payment && (
                    <div className="muted small">
                      {ruDate(m.payment.paid_on)}, {money(m.payment.amount_uzs)}
                    </div>
                  )}
                </td>
                <td className="num">
                  {!m.payment && (
                    <button className="btn btn-sm" onClick={() => setPay({ e, m })}>
                      Отметить выплаченной
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {add && <EmployeeModal employee={null} onClose={() => setAdd(false)} onDone={done} />}
      {edit && <EmployeeModal employee={edit} onClose={() => setEdit(null)} onDone={done} />}
      {pay && (
        <PayModal
          title={`Зарплата: ${pay.e.name}, ${monthName(pay.m.month)}`}
          amount={pay.m.amount_uzs}
          path={`/staff/finance/payroll/employees/${pay.e.id}/pay`}
          bodyOf={(paid_on, amount) => ({ month: pay.m.month, paid_on, amount_uzs: amount })}
          onClose={() => setPay(null)}
          onDone={(d) => done(d as PayrollData)}
        />
      )}
    </>
  );
}

function EmployeeModal({ employee, onClose, onDone }: { employee: Employee | null; onClose: () => void; onDone: (d: PayrollData) => void }) {
  const thisMonth = tashkentToday().slice(0, 7);
  const earliest = employee && employee.start_month > thisMonth ? employee.start_month : thisMonth;
  const [name, setName] = useState(employee?.name ?? '');
  const [amount, setAmount] = useState(employee ? String(employee.amount_uzs) : '400000');
  const [month, setMonth] = useState(employee ? earliest : thisMonth < '2026-11' ? '2026-11' : thisMonth);
  const sum = validSum(amount);
  const amountChanged = !employee || sum !== employee.amount_uzs;
  const valid = name.trim() !== '' && sum !== null && /^\d{4}-\d{2}$/.test(month) && (!employee || !amountChanged || month >= earliest);
  const save = useMutation({
    mutationFn: () =>
      employee
        ? api<PayrollData>(`/staff/finance/payroll/employees/${employee.id}`, { method: 'PATCH', body: { name: name.trim(), ...(amountChanged && { amount_uzs: sum, from_month: month }) } })
        : api<PayrollData>('/staff/finance/payroll/employees', { method: 'POST', body: { name: name.trim(), start_month: month, amount_uzs: sum } }),
    onSuccess: onDone,
  });
  return (
    <Modal title={employee ? `Изменить: ${employee.name}` : 'Новый сотрудник'} onClose={onClose}>
      <ErrorBox error={save.error} />
      <Field label="Имя">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
      </Field>
      <Field label="Сумма в месяц, сум">
        <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label={employee ? 'Новая сумма действует с месяца' : 'Начислять с месяца'} hint={employee ? 'Только текущий или будущий месяц: прошлые начисления не пересчитываются' : 'С этого месяца зарплата начисляется автоматически'}>
        <input type="month" value={month} min={employee ? earliest : undefined} onChange={(e) => setMonth(e.target.value)} />
      </Field>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button className="btn" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          Сохранить
        </button>
      </div>
    </Modal>
  );
}
