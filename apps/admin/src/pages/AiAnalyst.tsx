import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { PLATFORM_LABELS } from '../components/Competitors';
import { Badge, ErrorBox, Loading, PageHead } from '../components/ui';
import { api, errorText } from '../lib/api';
import { dateTime, money, ruDate } from '../lib/format';

interface Status {
  settings: { enabled: boolean; model: string; monthly_budget_usd: number };
  key_set: boolean;
  spent_month_usd: number;
  models: { id: string; input: number; output: number }[];
}

type MatchStatus = 'match' | 'mismatch' | 'incomplete';

interface FeedRow {
  index: number;
  kind: 'competitor_price' | 'orders' | 'bestseller_rank' | 'note';
  sku: string | null;
  platform: string | null;
  seller: string | null;
  title: string | null;
  price_uzs: number | null;
  observed_on: string;
  brand: string | null;
  match_form: string | null;
  dose_amount: number | null;
  dose_unit: string | null;
  dose_per: string | null;
  pack_count: number | null;
  orders_count: number | null;
  bestseller_rank: number | null;
  note: string | null;
  product: { id: string; sku: string; name_ru: string } | null;
  match: { status: MatchStatus; reasons: string[] } | null;
  problem: string | null;
}

interface FeedResult {
  id: string;
  rows: FeedRow[];
  unclear: string[];
  cost_usd: number;
}

interface Feed {
  id: string;
  created_at: string;
  status: 'parsed' | 'saved' | 'failed';
  text_preview: string;
  rows_count: number;
  saved: { competitor_prices: number; facts: number } | null;
  staff_name: string | null;
}

interface Fact {
  id: string;
  kind: string;
  product_id: string | null;
  product_sku: string | null;
  product_name: string | null;
  platform: string | null;
  seller: string | null;
  value_num: number | null;
  value_text: string | null;
  observed_on: string;
  source: string;
  staff_name: string | null;
}

interface ChatItem {
  id: string;
  question: string | null;
  answer: string | null;
  outcome: string;
  cost_usd: number;
  created_at: string;
}

interface RequestLog {
  month: { requests: number; cost_usd: number };
  items: { id: string; created_at: string; scenario: string; model: string; question: string | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost_usd: number; outcome: string; error_code: string | null; staff_name: string | null }[];
}

const KIND_LABELS: Record<string, string> = {
  competitor_price: 'Цена конкурента',
  orders: 'Заказы у конкурента',
  bestseller_rank: 'Место в бестселлерах iHerb',
  decision: 'Решение',
  note: 'Заметка',
};
const MATCH: Record<MatchStatus, [string, 'ok' | 'warn' | 'neutral']> = { match: ['1-в-1', 'ok'], mismatch: ['не тот товар', 'warn'], incomplete: ['не сравнить', 'neutral'] };
const UNITS: Record<string, string> = { mg: 'мг', mcg: 'мкг', iu: 'МЕ', g: 'г', ml: 'мл', cfu_bn: 'млрд КОЕ' };
const PER: Record<string, string> = { capsule: 'капс.', tablet: 'табл.', softgel: 'мягк. капс.', serving: 'порц.', drop: 'капл.' };
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const where = (r: { platform: string | null; seller: string | null }) => [r.seller, r.platform ? (PLATFORM_LABELS[r.platform] ?? r.platform) : null].filter(Boolean).join(' · ') || '—';

/**
 * Генплан, этап 5, ветка admin-ai-analyst (D-57, узел 5): «AI-аналитик» — admin only. The owner pastes raw data,
 * Claude reads it, our code checks «1-в-1», the owner saves; the chat answers from the shop data and the memory.
 */
export function AiAnalyst() {
  const status = useQuery({ queryKey: ['ai-analyst', 'status'], queryFn: () => api<Status>('/staff/ai-analyst/status') });
  return (
    <>
      <PageHead title="AI-аналитик" />
      {status.isPending ? <Loading /> : status.isError ? <ErrorBox error={status.error} onRetry={() => void status.refetch()} /> : <StatusCard s={status.data} />}
      <FeedCard />
      <ChatCard />
      <MemoryCard />
      <div className="grid-2">
        <FeedsCard />
        <RequestsCard />
      </div>
    </>
  );
}

function StatusCard({ s }: { s: Status }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ enabled: s.settings.enabled, model: s.settings.model, budget: String(s.settings.monthly_budget_usd) });
  const m = useMutation({
    mutationFn: () => api('/staff/ai-analyst/settings', { method: 'PUT', body: { enabled: f.enabled, model: f.model, monthly_budget_usd: Number(f.budget.replace(',', '.')) } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ai-analyst', 'status'] });
      setOpen(false);
    },
  });
  const left = Math.max(0, s.settings.monthly_budget_usd - s.spent_month_usd);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <section className="card">
      {!s.key_set && (
        <div className="alert alert-warn">
          <span>
            Нет ключа. Впишите свой ключ Anthropic в файл <code>apps/api/.env</code> строкой <code>ANTHROPIC_ADMIN_API_KEY=…</code> и перезапустите API. Ключ
            не вводится здесь и не пересылается в чат.
          </span>
        </div>
      )}
      <div className="ai-status">
        <span>{s.settings.enabled ? <Badge tone="ok">включён</Badge> : <Badge>выключен</Badge>}</span>
        <span className="small">Модель: {s.settings.model}</span>
        <span className="small">
          Потрачено в этом месяце: {usd(s.spent_month_usd)} из {usd(s.settings.monthly_budget_usd)} · осталось {usd(left)}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>
          {open ? 'Скрыть настройки' : 'Настройки'}
        </button>
      </div>
      {open && (
        <form onSubmit={submit} className="ai-settings">
          <label className="check">
            <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
            <span>AI-аналитик включён</span>
          </label>
          <label className="field">
            <span className="field-label">Модель</span>
            <select value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}>
              {s.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id} — ${m.input} / ${m.output} за 1 млн токенов
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Бюджет в месяц, $</span>
            <input inputMode="decimal" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} />
          </label>
          <div className="iherb-actions">
            <button type="submit" className="btn" disabled={m.isPending}>
              {m.isPending ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
          {m.isError && <p className="text-bad">{errorText(m.error)}</p>}
        </form>
      )}
    </section>
  );
}

/** Rows saved by default: everything that can be saved, except competitor prices that are not «1-в-1». */
const preselect = (rows: FeedRow[]) => new Set(rows.filter((r) => !r.problem && (r.kind !== 'competitor_price' || r.match?.status === 'match')).map((r) => r.index));

function FeedCard() {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<FeedResult | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [done, setDone] = useState<{ competitor_prices: number; facts: number } | null>(null);
  const check = useMutation({
    mutationFn: () => api<FeedResult>('/staff/ai-analyst/feed', { method: 'POST', body: { text } }),
    onSuccess: (r) => {
      setPreview(r);
      setChosen(preselect(r.rows));
      setDone(null);
      void qc.invalidateQueries({ queryKey: ['ai-analyst'] });
    },
  });
  const save = useMutation({
    mutationFn: () => api<{ competitor_prices: number; facts: number }>(`/staff/ai-analyst/feed/${preview!.id}/save`, { method: 'POST', body: { indexes: [...chosen] } }),
    onSuccess: (r) => {
      setDone(r);
      setPreview(null);
      setText('');
      void qc.invalidateQueries({ queryKey: ['ai-analyst'] });
      void qc.invalidateQueries({ queryKey: ['iherb'] });
      void qc.invalidateQueries({ queryKey: ['competitors'] });
    },
  });
  const toggle = (i: number) =>
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) check.mutate();
  };
  return (
    <section className="card">
      <h2>Загрузить данные</h2>
      <p className="muted">
        Вставьте сырой текст или таблицу: ответ ChatGPT, свои заметки, цены конкурентов, число заказов на Uzum, места в бестселлерах iHerb. Claude
        разберёт текст, программа строго сверит «1-в-1» (бренд, форма, доза, количество в банке), а в базу запишется только то, что вы отметите и
        сохраните.
      </p>
      <form onSubmit={submit} className="iherb-form">
        <label className="field">
          <span className="field-label">Текст или таблица</span>
          <textarea
            rows={6}
            value={text}
            maxLength={100_000}
            placeholder={'Uzum, магазин Fitvibe: NOW Magnesium Bisglycinate 200 мг, 90 капсул — 199 000 сум, 350 заказов\nАптека BioBox: то же — 250 000 сум'}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <div className="iherb-actions">
          <button type="submit" className="btn" disabled={!text.trim() || check.isPending}>
            {check.isPending ? 'Claude читает…' : 'Проверить'}
          </button>
        </div>
      </form>
      {check.isError && <ErrorBox error={check.error} />}
      {preview && (
        <>
          <h3>Что понял Claude</h3>
          <p className="muted small">Разбор стоил {usd(preview.cost_usd)}. Отметьте строки, которые нужно сохранить.</p>
          {preview.unclear.length > 0 && (
            <div className="alert alert-warn">
              <div>
                <strong>Не понял:</strong>
                <ul>
                  {preview.unclear.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {!preview.rows.length ? (
            <p className="muted">В тексте не нашлось фактов.</p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th aria-label="Сохранить" />
                    <th>Что</th>
                    <th>Товар VITALO</th>
                    <th>Где</th>
                    <th className="num">Значение</th>
                    <th>У конкурента</th>
                    <th>Сверка</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.index} className={r.problem ? 'row-muted' : undefined}>
                      <td>
                        <input type="checkbox" aria-label={`Сохранить строку ${r.index + 1}`} checked={chosen.has(r.index)} disabled={!!r.problem} onChange={() => toggle(r.index)} />
                      </td>
                      <td>
                        {KIND_LABELS[r.kind]}
                        <div className="muted small">{ruDate(r.observed_on)}</div>
                      </td>
                      <td>{r.product ? <Link to={`/products/${r.product.id}`}>{r.product.name_ru}</Link> : <span className="muted">{r.sku ?? '—'}</span>}</td>
                      <td>{where(r)}</td>
                      <td className="num">
                        {r.kind === 'competitor_price' && r.price_uzs != null && money(r.price_uzs)}
                        {r.kind === 'orders' && r.orders_count != null && `${r.orders_count.toLocaleString('ru-RU')} заказов`}
                        {r.kind === 'bestseller_rank' && r.bestseller_rank != null && `№${r.bestseller_rank}`}
                        {r.kind === 'competitor_price' && r.orders_count != null && <div className="muted small">заказов: {r.orders_count.toLocaleString('ru-RU')}</div>}
                        {r.kind === 'note' && <span className="small">{r.note}</span>}
                      </td>
                      <td className="small">
                        {r.kind === 'competitor_price' ? (
                          <>
                            {[r.brand, r.match_form].filter(Boolean).join(', ') || '—'}
                            {r.dose_amount != null && r.dose_unit && r.dose_per && (
                              <div>
                                {r.dose_amount} {UNITS[r.dose_unit] ?? r.dose_unit} / {PER[r.dose_per] ?? r.dose_per}
                              </div>
                            )}
                            {r.pack_count != null && <div>{r.pack_count} шт. в банке</div>}
                          </>
                        ) : (
                          r.title ?? ''
                        )}
                      </td>
                      <td>
                        {r.problem ? (
                          <span className="text-bad small">{r.problem}</span>
                        ) : r.match ? (
                          <>
                            <Badge tone={MATCH[r.match.status][1]}>{MATCH[r.match.status][0]}</Badge>
                            {r.match.reasons.map((x) => (
                              <div key={x} className="muted small">
                                {x}
                              </div>
                            ))}
                          </>
                        ) : (
                          <span className="muted small">в память</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">Цены «не тот товар» сохраняются с пометкой и в графики и «минимум рынка» не идут.</p>
          <div className="iherb-actions">
            <button type="button" className="btn" disabled={!chosen.size || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Сохраняю…' : `Сохранить отмеченные (${chosen.size})`}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setPreview(null)}>
              Отмена
            </button>
          </div>
          {save.isError && <p className="text-bad">{errorText(save.error)}</p>}
        </>
      )}
      {done && (
        <div className="alert alert-ok">
          Сохранено: цен конкурентов {done.competitor_prices}, фактов в память {done.facts}.
        </div>
      )}
    </section>
  );
}

function ChatCard() {
  const qc = useQueryClient();
  const history = useQuery({ queryKey: ['ai-analyst', 'chat'], queryFn: () => api<ChatItem[]>('/staff/ai-analyst/chat') });
  const [q, setQ] = useState('');
  const ask = useMutation({
    mutationFn: () => api<ChatItem>('/staff/ai-analyst/chat', { method: 'POST', body: { question: q } }),
    onSuccess: () => {
      setQ('');
      void qc.invalidateQueries({ queryKey: ['ai-analyst'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) ask.mutate();
  };
  return (
    <section className="card">
      <h2>Чат</h2>
      <p className="muted small">
        Аналитик видит товары со ссылкой iHerb: цены, закупку, остатки, продажи за 30 дней, сигналы закупки, цены конкурентов «1-в-1» и память о
        бизнесе. Он только советует — цены и заказы не меняет.
      </p>
      {history.isPending ? (
        <Loading />
      ) : history.isError ? (
        <ErrorBox error={history.error} />
      ) : (
        <div className="ai-chat">
          {!history.data.length && <p className="muted">Например: «Что выгодно закупить на этой неделе?» или «Где мы дороже рынка?»</p>}
          {history.data.map((h) => (
            <div key={h.id} className="ai-chat-pair">
              <div className="ai-chat-q">{h.question}</div>
              <div className="ai-chat-a">{h.answer ? <AnswerText text={h.answer} /> : <span className="muted">Нет ответа ({h.outcome})</span>}</div>
              <div className="muted small">
                {dateTime(h.created_at)} · {usd(h.cost_usd)}
              </div>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="iherb-form">
        <label className="field">
          <span className="field-label">Вопрос</span>
          <textarea rows={3} value={q} maxLength={4000} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="iherb-actions">
          <button type="submit" className="btn" disabled={!q.trim() || ask.isPending}>
            {ask.isPending ? 'Claude думает…' : 'Спросить'}
          </button>
        </div>
      </form>
      {ask.isError && <ErrorBox error={ask.error} />}
    </section>
  );
}

/** The answer as plain text with **bold** — no HTML from the model is ever rendered. */
export function AnswerText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) =>
        part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

function MemoryCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ai-analyst', 'memory'], queryFn: () => api<Fact[]>('/staff/ai-analyst/memory') });
  const products = useQuery({ queryKey: ['iherb', 'products'], queryFn: () => api<{ id: string; sku: string; name_ru: string }[]>('/staff/iherb/products') });
  const [f, setF] = useState({ kind: 'decision', product_id: '', text: '' });
  const add = useMutation({
    mutationFn: () => api('/staff/ai-analyst/memory', { method: 'POST', body: { kind: f.kind, product_id: f.product_id || null, text: f.text } }),
    onSuccess: () => {
      setF({ ...f, text: '' });
      void qc.invalidateQueries({ queryKey: ['ai-analyst', 'memory'] });
    },
  });
  const off = useMutation({
    mutationFn: (id: string) => api(`/staff/ai-analyst/memory/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-analyst', 'memory'] }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (f.text.trim()) add.mutate();
  };
  return (
    <section className="card">
      <h2>Память о бизнесе</h2>
      <p className="muted small">Факты из ваших загрузок и ваши решения. Аналитик учитывает их в каждом ответе. «Убрать» — факт перестаёт учитываться, но остаётся в журнале.</p>
      <form onSubmit={submit} className="memory-form">
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="Вид записи">
          <option value="decision">Решение</option>
          <option value="note">Заметка</option>
        </select>
        <select value={f.product_id} onChange={(e) => setF({ ...f, product_id: e.target.value })} aria-label="Товар">
          <option value="">Без товара</option>
          {(products.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.sku} — {p.name_ru}
            </option>
          ))}
        </select>
        <input value={f.text} maxLength={2000} placeholder="Например: магний берём в Ташкенте, пока Fitvibe дешевле" onChange={(e) => setF({ ...f, text: e.target.value })} aria-label="Текст" />
        <button type="submit" className="btn" disabled={!f.text.trim() || add.isPending}>
          Записать
        </button>
      </form>
      {add.isError && <p className="text-bad">{errorText(add.error)}</p>}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : !q.data.length ? (
        <p className="muted">Память пока пуста.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Что</th>
                <th>Товар</th>
                <th>Где</th>
                <th>Значение</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((m) => (
                <tr key={m.id}>
                  <td>{ruDate(m.observed_on)}</td>
                  <td>
                    {KIND_LABELS[m.kind] ?? m.kind}
                    <div className="muted small">{m.source === 'manual' ? 'вручную' : 'из загрузки'}</div>
                  </td>
                  <td>{m.product_id ? <Link to={`/products/${m.product_id}`}>{m.product_name}</Link> : '—'}</td>
                  <td>{where(m)}</td>
                  <td>
                    {m.value_num != null && <strong>{m.kind === 'bestseller_rank' ? `№${m.value_num}` : m.value_num.toLocaleString('ru-RU')} </strong>}
                    {m.value_text}
                  </td>
                  <td className="num">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={off.isPending}
                      onClick={() => {
                        if (window.confirm('Убрать этот факт из памяти аналитика?')) off.mutate(m.id);
                      }}
                    >
                      Убрать
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const FEED_STATUS: Record<Feed['status'], [string, 'ok' | 'warn' | 'neutral' | 'bad']> = { parsed: ['не сохранено', 'neutral'], saved: ['сохранено', 'ok'], failed: ['не разобрано', 'bad'] };

function FeedsCard() {
  const q = useQuery({ queryKey: ['ai-analyst', 'feeds'], queryFn: () => api<Feed[]>('/staff/ai-analyst/feed') });
  return (
    <section className="card">
      <h2>Что я прислал</h2>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : !q.data.length ? (
        <p className="muted">Загрузок ещё не было.</p>
      ) : (
        <ul className="plain-list">
          {q.data.map((f) => (
            <li key={f.id}>
              <div>
                {dateTime(f.created_at)} <Badge tone={FEED_STATUS[f.status][1]}>{FEED_STATUS[f.status][0]}</Badge>
                {f.saved && (
                  <span className="muted small">
                    {' '}
                    цен {f.saved.competitor_prices}, фактов {f.saved.facts}
                  </span>
                )}
              </div>
              <div className="muted small ai-feed-text">{f.text_preview}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RequestsCard() {
  const q = useQuery({ queryKey: ['ai-analyst', 'requests'], queryFn: () => api<RequestLog>('/staff/ai-analyst/requests') });
  return (
    <section className="card">
      <h2>Журнал запросов</h2>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : (
        <>
          <p className="small">
            В этом месяце: запросов {q.data.month.requests}, потрачено {usd(q.data.month.cost_usd)}
          </p>
          {!q.data.items.length ? (
            <p className="muted">Запросов ещё не было.</p>
          ) : (
            <ul className="plain-list">
              {q.data.items.map((r) => (
                <li key={r.id}>
                  {dateTime(r.created_at)} · {r.scenario === 'chat' ? 'чат' : 'загрузка'} · {usd(r.cost_usd)}
                  {r.outcome !== 'ok' && <Badge tone="warn">{r.error_code ?? r.outcome}</Badge>}
                  <div className="muted small">
                    {r.model} · токены: {r.input_tokens + r.cache_read_tokens + r.cache_write_tokens} → {r.output_tokens}
                    {r.cache_read_tokens > 0 && ` (из кеша ${r.cache_read_tokens})`}
                    {r.cache_write_tokens > 0 && ` (в кеш ${r.cache_write_tokens})`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
