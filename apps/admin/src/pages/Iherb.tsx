import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Badge, ErrorBox, Loading, PageHead } from '../components/ui';
import { Competitors, CostBars, PLATFORM_LABELS } from '../components/Competitors';
import { SignalChips, SignalList, type PurchaseSignal } from '../components/PurchaseSignals';
import { api, errorText } from '../lib/api';
import { dateTime, money } from '../lib/format';

interface AutoResult {
  target_uzs: number;
  apply: boolean;
  skip_reason: string | null;
  skip_label: string | null;
  floor_applied: boolean;
  big_jump: boolean;
}

interface PreviewRow {
  iherb_product_id: string;
  title: string | null;
  price_uzs: number;
  list_price_uzs: number | null;
  in_stock: boolean;
  bestseller: boolean;
  bestseller_rank: number | null;
  weight_kg: number | null;
  product: { id: string; sku: string; name_ru: string; price_uzs: number; status: string } | null;
  last_price_uzs: number | null;
  change_pct: number | null;
  auto: AutoResult | null;
}

interface UploadResult {
  upload_id?: string;
  format: 'html' | 'table';
  items: PreviewRow[];
  problems: string[];
  summary: { total: number; matched: number; unknown: number; will_change: number; big_jumps: number };
}

interface IherbProduct {
  id: string;
  sku: string;
  name_ru: string;
  status: string;
  price_uzs: number;
  iherb_url: string | null;
  iherb_product_id: string;
  auto_pricing_enabled: boolean;
  markup_percent: number;
  price_round_to: number;
  stock_price_mode: string;
  available: number;
  cost_uzs: number | null;
  /** the lowest «1-в-1» competitor price of the last 60 days */
  market_min_uzs: number | null;
  competitors_count: number;
  last_snapshot: { price_uzs: number; in_stock: boolean; bestseller: boolean; bestseller_rank: number | null; taken_at: string } | null;
  /** the last iHerb price + delivery by weight */
  iherb_landed_uzs: number | null;
  weight_missing: boolean;
  /** the average of daily averages of the landed cost, 30 days */
  avg30_uzs: number | null;
  avg_days: number;
  signals: PurchaseSignal[];
  last_change: { old_price_uzs: number; new_price_uzs: number; big_jump: boolean; floor_applied: boolean; yandex_check: boolean; created_at: string } | null;
}

/** Аудит 4.7: auto pricing is on, but no iHerb price has ever been loaded for the product. */
export const autoIdle = (p: Pick<IherbProduct, 'auto_pricing_enabled' | 'last_snapshot'>) => p.auto_pricing_enabled && !p.last_snapshot;

interface History {
  product: { id: string; sku: string; name_ru: string; price_uzs: number; cost_uzs: number | null; markup_percent: number };
  snapshots: { taken_at: string; price_uzs: number; list_price_uzs: number | null; in_stock: boolean; bestseller: boolean }[];
  changes: { created_at: string; old_price_uzs: number; new_price_uzs: number; iherb_price_uzs: number | null; big_jump: boolean; floor_applied: boolean; yandex_check: boolean }[];
  competitors?: { observed_on: string; platform: string; seller: string | null; price_uzs: number }[];
  competitors_latest?: { observed_on: string; platform: string; seller: string | null; price_uzs: number }[];
  iherb_landed_uzs?: number | null;
  weight_missing?: boolean;
  avg30_uzs?: number | null;
  avg_days?: number;
  signals?: PurchaseSignal[];
  shipping_rate_per_kg_uzs?: number;
}

interface IherbSettings {
  reminders: boolean;
  shipping_rate_per_kg_uzs: number;
  signal_a_pct: number;
  signal_a_strong_pct: number;
  signal_b_pct: number;
}

interface Upload {
  id: string;
  created_at: string;
  items_total: number;
  items_matched: number;
  prices_changed: number;
  staff_name: string | null;
}

/** A jump of the iHerb price itself this big is worth a second look before saving (a misread price). */
const SUSPICIOUS_PCT = 30;

/**
 * Генплан, этап 5, ветка iherb-2-prices (D-57): «iHerb и цены» — admin only. The owner saves the iHerb wishlist page
 * (or pastes a table), checks the preview, saves: the snapshot goes to the history and the auto prices apply at once.
 */
export function Iherb() {
  return (
    <>
      <PageHead title="iHerb и цены" />
      <SignalsCard />
      <UploadCard />
      <ProductsCard />
      <div className="grid-2">
        <SettingsCard />
        <UploadsCard />
      </div>
    </>
  );
}

function UploadCard() {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<UploadResult | null>(null);
  const [saved, setSaved] = useState<UploadResult | null>(null);
  const form = () => {
    const f = new FormData();
    if (file) f.append('file', file);
    else f.append('text', text);
    return f;
  };
  const check = useMutation({
    mutationFn: () => api<UploadResult>('/staff/iherb/uploads?dry_run=1', { method: 'POST', form: form() }),
    onSuccess: (r) => {
      setPreview(r);
      setSaved(null);
    },
  });
  const save = useMutation({
    mutationFn: () => api<UploadResult>('/staff/iherb/uploads', { method: 'POST', form: form() }),
    onSuccess: (r) => {
      setSaved(r);
      setPreview(null);
      setFile(null);
      setText('');
      void qc.invalidateQueries({ queryKey: ['iherb'] });
    },
  });
  const ready = !!file || text.trim().length > 0;
  const onCheck = (e: FormEvent) => {
    e.preventDefault();
    if (ready) check.mutate();
  };
  const suspicious = preview?.items.filter((r) => r.change_pct != null && Math.abs(r.change_pct) >= SUSPICIOUS_PCT).length ?? 0;

  return (
    <section className="card">
      <div className="section-head">
        <h2>Загрузить вишлист iHerb</h2>
      </div>
      <ol className="iherb-howto muted">
        <li>Откройте свой вишлист на iHerb. Валюта должна быть «UZS — сум».</li>
        <li>
          Нажмите Ctrl+S и сохраните страницу как «Веб-страница полностью». Можно вместо этого вставить таблицу: в каждой строке ссылка
          или номер товара iHerb и цена в сумах; «нет», если товара нет в наличии.
        </li>
        <li>Нажмите «Проверить»: ничего не сохранится, пока вы не посмотрите результат.</li>
      </ol>
      <form onSubmit={onCheck} className="iherb-form">
        <label className="field">
          <span className="field-label">Сохранённая страница (.html) или таблица (.csv, .txt)</span>
          <input
            type="file"
            accept=".html,.htm,.txt,.csv,text/html,text/plain,text/csv"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
            }}
          />
        </label>
        {!file && (
          <label className="field">
            <span className="field-label">Или вставьте таблицу</span>
            <textarea
              rows={4}
              value={text}
              placeholder={'https://uz.iherb.com/pr/…/62118; 245 000\n2902; 120 500; нет'}
              onChange={(e) => {
                setText(e.target.value);
                setPreview(null);
              }}
            />
          </label>
        )}
        <div className="iherb-actions">
          <button type="submit" className="btn" disabled={!ready || check.isPending}>
            {check.isPending ? 'Проверяю…' : 'Проверить'}
          </button>
          {file && (
            <button type="button" className="btn btn-ghost" onClick={() => setFile(null)}>
              Убрать файл
            </button>
          )}
        </div>
      </form>
      {check.isError && <ErrorBox error={check.error} />}
      {check.isError && <Problems list={(check.error as { body?: { problems?: string[] } }).body?.problems ?? []} />}

      {preview && (
        <>
          <h3>Что получится</h3>
          <p>
            Товаров в вишлисте: <strong>{preview.summary.total}</strong>, из них есть в VITALO: <strong>{preview.summary.matched}</strong>.
            Цена VITALO изменится у <strong>{preview.summary.will_change}</strong>
            {preview.summary.big_jumps > 0 && <> (больше чем на 20% — у {preview.summary.big_jumps})</>}.
          </p>
          {suspicious > 0 && (
            <div className="alert alert-warn">
              У {suspicious} товаров цена iHerb изменилась на {SUSPICIOUS_PCT}% и больше с прошлой загрузки. Сверьте их с сайтом: если цена прочитана
              неверно, не сохраняйте, а вставьте таблицу вручную.
            </div>
          )}
          <Problems list={preview.problems} />
          <PreviewTable rows={preview.items} />
          <div className="iherb-actions">
            <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Сохраняю…' : preview.summary.will_change ? `Сохранить и поменять ${preview.summary.will_change} цен` : 'Сохранить срез'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setPreview(null)}>
              Отмена
            </button>
          </div>
          {save.isError && <p className="text-bad">{errorText(save.error)}</p>}
        </>
      )}
      {saved && (
        <div className="alert alert-ok">
          Срез сохранён: товаров {saved.summary.total}, в VITALO {saved.summary.matched}, цен изменено {saved.summary.will_change}.
          {saved.items.some((r) => r.auto?.apply) && ' Если товар продаётся и на Яндекс Маркете, проверьте там цену.'}
        </div>
      )}
    </section>
  );
}

function Problems({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <details className="alert alert-warn">
      <summary>Не прочитано: {list.length}</summary>
      <ul>
        {list.slice(0, 50).map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </details>
  );
}

function PreviewTable({ rows }: { rows: PreviewRow[] }) {
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>Товар iHerb</th>
            <th className="num">Цена iHerb</th>
            <th className="num">Было на iHerb</th>
            <th>Товар VITALO</th>
            <th className="num">Цена VITALO</th>
            <th>Автоцена</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.iherb_product_id} className={r.change_pct != null && Math.abs(r.change_pct) >= SUSPICIOUS_PCT ? 'row-warn' : undefined}>
              <td>
                {r.title && <div>{r.title}</div>}
                <div className="muted small">
                  № {r.iherb_product_id}
                  {!r.in_stock && ' · нет в наличии'}
                  {r.bestseller && (r.bestseller_rank ? ` · бестселлер №${r.bestseller_rank}` : ' · бестселлер')}
                  {r.weight_kg != null && ` · ${r.weight_kg} кг`}
                </div>
              </td>
              <td className="num">
                {money(r.price_uzs)}
                {r.list_price_uzs != null && <div className="muted small strike">{money(r.list_price_uzs)}</div>}
              </td>
              <td className="num">
                {r.last_price_uzs == null ? '—' : money(r.last_price_uzs)}
                {r.change_pct != null && r.change_pct !== 0 && (
                  <div className={Math.abs(r.change_pct) >= SUSPICIOUS_PCT ? 'small text-warn' : 'muted small'}>
                    {r.change_pct > 0 ? '+' : ''}
                    {r.change_pct}%
                  </div>
                )}
              </td>
              <td>
                {r.product ? (
                  <Link to={`/products/${r.product.id}`}>{r.product.name_ru}</Link>
                ) : (
                  <span className="muted">нет — сохранится в историю, пока ссылку не укажут в карточке</span>
                )}
              </td>
              <td className="num">{r.product ? money(r.product.price_uzs) : '—'}</td>
              <td>
                <AutoCell auto={r.auto} hasProduct={!!r.product} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AutoCell({ auto, hasProduct }: { auto: AutoResult | null; hasProduct: boolean }) {
  if (!hasProduct) return <span className="muted">—</span>;
  if (!auto) return <span className="muted">выключена</span>;
  if (!auto.apply) return <span className="muted">{auto.skip_label}</span>;
  return (
    <span>
      → <strong>{money(auto.target_uzs)}</strong>{' '}
      {auto.big_jump && <Badge tone="warn">больше 20%</Badge>} {auto.floor_applied && <Badge tone="info">не ниже себестоимости</Badge>}
    </span>
  );
}

function ProductsCard() {
  const q = useQuery({ queryKey: ['iherb', 'products'], queryFn: () => api<IherbProduct[]>('/staff/iherb/products') });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="card flush">
      <div className="section-head pad">
        <h2>Товары со ссылкой iHerb</h2>
      </div>
      {/* аудит 4.7: auto pricing switched on, but there is no iHerb price to work from */}
      {!!q.data?.filter(autoIdle).length && (
        <div className="alert alert-warn pad">
          Автоцена не действует у {q.data.filter(autoIdle).length} товар(ов): нет цен iHerb. Загрузите вишлист выше — тогда цена начнёт считаться.
        </div>
      )}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data.length ? (
        <p className="muted pad">Пока ни у одного товара нет ссылки iHerb. Её указывают в карточке товара, в разделе «iHerb и сверка «1-в-1»».</p>
      ) : (
        <div className="table-scroll">
          <table className="table table-hover">
            <thead>
              <tr>
                <th>Товар</th>
                <th className="num">iHerb</th>
                <th className="num">VITALO</th>
                <th className="num">Рынок «1-в-1»</th>
                <th className="num">Маржа к себестоимости</th>
                <th>Автоцена</th>
                <th>Последнее изменение</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((p) => (
                <ProductRow key={p.id} p={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ProductRow({ p, open, onToggle }: { p: IherbProduct; open: boolean; onToggle: () => void }) {
  const margin = p.cost_uzs ? Math.round(((p.price_uzs - p.cost_uzs) * 100) / p.cost_uzs) : null;
  return (
    <>
      <tr>
        <td>
          <button type="button" className="link-button strong" aria-expanded={open} onClick={onToggle}>
            {p.name_ru}
          </button>
          <div className="muted small">
            {p.sku} · № iHerb {p.iherb_product_id} · на складе {p.available}
          </div>
          <SignalChips signals={p.signals ?? []} />
        </td>
        <td className="num">
          {p.last_snapshot ? (
            <>
              {money(p.last_snapshot.price_uzs)}
              <div className="muted small">
                {dateTime(p.last_snapshot.taken_at)}
                {!p.last_snapshot.in_stock && ' · нет в наличии'}
                {p.last_snapshot.bestseller_rank ? ` · бестселлер №${p.last_snapshot.bestseller_rank}` : p.last_snapshot.bestseller ? ' · бестселлер' : ''}
              </div>
              {p.iherb_landed_uzs != null && p.iherb_landed_uzs !== p.last_snapshot.price_uzs && <div className="muted small">с доставкой {money(p.iherb_landed_uzs)}</div>}
              {p.avg30_uzs != null && (
                <div className="muted small" title={`Средняя по дням, дней с замерами: ${p.avg_days}`}>
                  средняя 30 дн. {money(p.avg30_uzs)}
                </div>
              )}
            </>
          ) : (
            <span className="muted">ещё не загружалась</span>
          )}
        </td>
        <td className="num">{money(p.price_uzs)}</td>
        <td className="num">
          {p.market_min_uzs == null ? (
            <span className="muted">—</span>
          ) : (
            <>
              от {money(p.market_min_uzs)}
              <div className={p.market_min_uzs < p.price_uzs ? 'small text-warn' : 'muted small'}>
                {p.market_min_uzs < p.price_uzs ? 'дешевле нашей' : 'не дешевле нашей'} · цен {p.competitors_count}
              </div>
            </>
          )}
        </td>
        <td className="num">{margin == null ? <span className="muted">нет себестоимости</span> : `${margin}%`}</td>
        <td>
          {p.auto_pricing_enabled ? (
            <>
              {autoIdle(p) ? <Badge tone="warn">не действует</Badge> : <Badge tone="ok">вкл</Badge>} <span className="small">+{p.markup_percent}%</span>
              {autoIdle(p) && <div className="small text-warn">нет цен iHerb</div>}
              <div className="muted small">{p.stock_price_mode === 'dynamic' ? 'меняется и при наличии' : 'при наличии не меняется'}</div>
            </>
          ) : (
            <span className="muted">выкл</span>
          )}
        </td>
        <td>
          {p.last_change ? (
            <>
              {money(p.last_change.old_price_uzs)} → {money(p.last_change.new_price_uzs)}
              <div className="muted small">{dateTime(p.last_change.created_at)}</div>
              {p.last_change.big_jump && <Badge tone="warn">больше 20%</Badge>} {p.last_change.yandex_check && <Badge tone="info">проверьте Яндекс</Badge>}
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7}>
            <PriceChart productId={p.id} />
            <Competitors productId={p.id} />
            <p className="small">
              <Link to={`/products/${p.id}`}>Открыть карточку товара</Link>
              {p.iherb_url && (
                <>
                  {' · '}
                  <a href={p.iherb_url} target="_blank" rel="noreferrer noopener">
                    Страница на iHerb
                  </a>
                </>
              )}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

const DAYS = [30, 90, 365] as const;

function PriceChart({ productId }: { productId: string }) {
  const [days, setDays] = useState<(typeof DAYS)[number]>(90);
  const q = useQuery({ queryKey: ['iherb', 'history', productId, days], queryFn: () => api<History>(`/staff/iherb/products/${productId}/history?days=${days}`) });
  return (
    <div className="price-chart-box">
      <div className="segmented">
        {DAYS.map((d) => (
          <button key={d} type="button" className={d === days ? 'is-on' : undefined} onClick={() => setDays(d)}>
            {d === 365 ? 'Год' : `${d} дней`}
          </button>
        ))}
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : (
        <>
          <Chart h={q.data} days={days} />
          <SignalList signals={q.data.signals ?? []} />
          <h3>Закупка, наша цена и конкуренты</h3>
          <CostBars d={{ cost_uzs: q.data.product.cost_uzs, iherb_landed_uzs: q.data.iherb_landed_uzs, price_uzs: q.data.product.price_uzs, competitors: q.data.competitors_latest ?? [] }} />
          {q.data.iherb_landed_uzs != null && (
            <p className="muted small">
              Закупка iHerb = последняя цена iHerb
              {q.data.shipping_rate_per_kg_uzs ? ` + вес × ${money(q.data.shipping_rate_per_kg_uzs)} за кг` : ' (доставка бесплатная — меняется в настройках внизу страницы)'}
              {q.data.weight_missing && '. Вес банки на iHerb неизвестен — доставка не учтена'}
              {q.data.avg30_uzs != null && `. Средняя за 30 дней: ${money(q.data.avg30_uzs)} (дней с замерами: ${q.data.avg_days})`}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Line chart: the iHerb price (3 points a day), the VITALO price (steps at every change) and the purchase cost. */
export function Chart({ h, days }: { h: History; days: number }) {
  const W = 640;
  const H = 200;
  const PAD_L = 8;
  const now = Date.now();
  const from = now - days * 86400_000;
  const market = h.competitors ?? [];
  if (!h.snapshots.length && !h.changes.length && !market.length) return <p className="muted">За этот период загрузок не было.</p>;
  // VITALO price over time: before the first change in the period — its old price, then each new price
  const ours: { t: number; v: number }[] = [];
  ours.push({ t: from, v: h.changes.length ? h.changes[0].old_price_uzs : h.product.price_uzs });
  for (const c of h.changes) ours.push({ t: new Date(c.created_at).getTime(), v: c.new_price_uzs });
  ours.push({ t: now, v: h.product.price_uzs });
  const values = [...h.snapshots.map((s) => s.price_uzs), ...ours.map((o) => o.v), ...market.map((m) => m.price_uzs), ...(h.product.cost_uzs ? [h.product.cost_uzs] : [])];
  const max = Math.max(...values) * 1.08;
  const min = Math.max(0, Math.min(...values) * 0.85);
  const x = (t: number) => PAD_L + ((t - from) / (now - from)) * (W - PAD_L * 2);
  const y = (v: number) => H - ((v - min) / (max - min || 1)) * (H - 10);
  const steps = ours.map((o, i) => (i === 0 ? `M${x(o.t)},${y(o.v)}` : `H${x(o.t)}V${y(o.v)}`)).join('');
  const iherb = h.snapshots.map((s) => `${x(new Date(s.taken_at).getTime())},${y(s.price_uzs)}`).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => from + k * (now - from));
  const fmtDay = (t: number) => new Date(t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  return (
    <>
      <div className="chart-legend small">
        <span>
          <i className="swatch swatch-iherb" /> iHerb
        </span>
        <span>
          <i className="swatch swatch-vitalo" /> VITALO
        </span>
        {market.length > 0 && (
          <span>
            <i className="swatch swatch-market" /> конкуренты «1-в-1»
          </span>
        )}
        {h.product.cost_uzs != null && (
          <span>
            <i className="swatch swatch-cost" /> себестоимость {money(h.product.cost_uzs)}
          </span>
        )}
        <span className="muted">
          пустой кружок — на iHerb не было в наличии · от {money(Math.round(min))} до {money(Math.round(max))}
        </span>
      </div>
      <svg className="sales-chart price-chart" viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label="Цена iHerb и цена VITALO по дням">
        <line x1={0} x2={W} y1={H} y2={H} className="chart-axis" />
        {h.product.cost_uzs != null && <line x1={PAD_L} x2={W - PAD_L} y1={y(h.product.cost_uzs)} y2={y(h.product.cost_uzs)} className="line-cost" />}
        <path d={steps} className="line-vitalo" />
        {h.snapshots.length > 1 && <polyline points={iherb} className="line-iherb" />}
        {h.snapshots.map((s) => (
          <circle key={s.taken_at} cx={x(new Date(s.taken_at).getTime())} cy={y(s.price_uzs)} r={3} className={s.in_stock ? 'dot-iherb' : 'dot-iherb dot-empty'}>
            <title>
              {dateTime(s.taken_at)}: iHerb {money(s.price_uzs)}
              {s.in_stock ? '' : ', нет в наличии'}
            </title>
          </circle>
        ))}
        {h.changes.map((c) => (
          <circle key={c.created_at} cx={x(new Date(c.created_at).getTime())} cy={y(c.new_price_uzs)} r={3.5} className="dot-vitalo">
            <title>
              {dateTime(c.created_at)}: VITALO {money(c.old_price_uzs)} → {money(c.new_price_uzs)}
            </title>
          </circle>
        ))}
        {market.map((m, i) => (
          <rect key={`m${i}`} x={x(new Date(`${m.observed_on}T12:00:00Z`).getTime()) - 3} y={y(m.price_uzs) - 3} width={6} height={6} className="dot-market">
            <title>
              {m.observed_on.split('-').reverse().join('.')}: {PLATFORM_LABELS[m.platform] ?? m.platform}
              {m.seller ? `, ${m.seller}` : ''} — {money(m.price_uzs)}
            </title>
          </rect>
        ))}
        {ticks.map((t) => (
          <text key={t} x={Math.min(W - 20, Math.max(20, x(t)))} y={H + 14} textAnchor="middle" className="chart-label">
            {fmtDay(t)}
          </text>
        ))}
      </svg>
    </>
  );
}

/** «Сигналы закупки»: every product with signal A or B, on top of the page. */
function SignalsCard() {
  const q = useQuery({ queryKey: ['iherb', 'products'], queryFn: () => api<IherbProduct[]>('/staff/iherb/products') });
  if (!q.data) return null;
  const withSignals = q.data.filter((p) => p.signals?.length);
  return (
    <section className="card">
      <h2>Сигналы закупки</h2>
      {!withSignals.length ? (
        <p className="muted">
          Сейчас сигналов нет. Сигнал А появляется, когда закупка на iHerb дешевле своей средней за 30 дней; сигнал Б — когда товар «1-в-1» в
          Узбекистане дешевле или почти как на iHerb.
        </p>
      ) : (
        <ul className="plain-list signal-products">
          {withSignals.map((p) => (
            <li key={p.id}>
              <Link to={`/products/${p.id}`} className="strong">
                {p.name_ru}
              </Link>{' '}
              <span className="muted small">
                {p.sku} · на складе {p.available}
              </span>
              <SignalList signals={p.signals} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Reminders and the purchase signal settings (owner, 09.11): delivery per kg and the thresholds of rules A and B. */
function SettingsCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['iherb', 'settings'], queryFn: () => api<IherbSettings>('/staff/iherb/settings') });
  const m = useMutation({
    mutationFn: (body: Partial<IherbSettings>) => api<IherbSettings>('/staff/iherb/settings', { method: 'PUT', body }),
    onSuccess: (r) => {
      qc.setQueryData(['iherb', 'settings'], r);
      void qc.invalidateQueries({ queryKey: ['iherb', 'products'] });
      void qc.invalidateQueries({ queryKey: ['iherb', 'history'] });
    },
  });
  return (
    <section className="card">
      <h2>Настройки</h2>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : (
        <>
          <label className="check">
            <input type="checkbox" checked={q.data.reminders} disabled={m.isPending} onChange={(e) => m.mutate({ reminders: e.target.checked })} />
            <span>
              Напоминать администраторам в Telegram в 09:00, 15:00 и 21:00, если вишлист ещё не загружали
              <span className="muted small"> — не чаще одного раза в каждое из этих времён</span>
            </span>
          </label>
          <SignalSettingsForm key={JSON.stringify(q.data)} s={q.data} pending={m.isPending} onSave={(b) => m.mutate(b)} />
        </>
      )}
      {m.isError && <p className="text-bad">{errorText(m.error)}</p>}
    </section>
  );
}

function SignalSettingsForm({ s, pending, onSave }: { s: IherbSettings; pending: boolean; onSave: (b: Partial<IherbSettings>) => void }) {
  const [f, setF] = useState({
    shipping_rate_per_kg_uzs: String(s.shipping_rate_per_kg_uzs),
    signal_a_pct: String(s.signal_a_pct),
    signal_a_strong_pct: String(s.signal_a_strong_pct),
    signal_b_pct: String(s.signal_b_pct),
  });
  const n = (v: string) => Number(v.replace(/\s/g, '').replace(',', '.'));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave({ shipping_rate_per_kg_uzs: Math.round(n(f.shipping_rate_per_kg_uzs)), signal_a_pct: n(f.signal_a_pct), signal_a_strong_pct: n(f.signal_a_strong_pct), signal_b_pct: n(f.signal_b_pct) });
  };
  const input = (k: keyof typeof f, suffix: string) => (
    <span className="input-suffix">
      <input inputMode="decimal" value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} />
      <span className="muted small">{suffix}</span>
    </span>
  );
  return (
    <form onSubmit={submit} className="signal-settings">
      <h3>Сигналы закупки</h3>
      <label className="field">
        <span className="field-label">Доставка с iHerb, сум за кг</span>
        {input('shipping_rate_per_kg_uzs', 'сум/кг')}
        <span className="muted small">0 — доставка бесплатная. Закупка iHerb = цена + вес банки × это число.</span>
      </label>
      <label className="field">
        <span className="field-label">Сигнал А «Выгодный закуп на iHerb»: ниже средней за 30 дней на</span>
        {input('signal_a_pct', '%')}
      </label>
      <label className="field">
        <span className="field-label">«Сильная просадка» — ниже средней на</span>
        {input('signal_a_strong_pct', '%')}
      </label>
      <label className="field">
        <span className="field-label">Сигнал Б «Перехват в Ташкенте»: дороже закупки iHerb не больше чем на</span>
        {input('signal_b_pct', '%')}
        <span className="muted small">Если в Узбекистане «1-в-1» дешевле закупки iHerb — сигнал «Срочно брать в Ташкенте».</span>
      </label>
      <div className="iherb-actions">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Сохраняю…' : 'Сохранить настройки'}
        </button>
      </div>
    </form>
  );
}

function UploadsCard() {
  const q = useQuery({ queryKey: ['iherb', 'uploads'], queryFn: () => api<Upload[]>('/staff/iherb/uploads') });
  return (
    <section className="card">
      <h2>Последние загрузки</h2>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} />
      ) : !q.data.length ? (
        <p className="muted">Загрузок ещё не было.</p>
      ) : (
        <ul className="plain-list">
          {q.data.slice(0, 10).map((u) => (
            <li key={u.id}>
              {dateTime(u.created_at)} — товаров {u.items_total}, в VITALO {u.items_matched}, цен изменено {u.prices_changed}
              {u.staff_name && <span className="muted"> · {u.staff_name}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
