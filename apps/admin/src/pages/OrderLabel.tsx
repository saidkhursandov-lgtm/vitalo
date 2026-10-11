import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ErrorBox } from '../components/ui';
import { api } from '../lib/api';
import { prettyPhone, ruDate } from '../lib/format';
import { QrCode } from './Labels';

/**
 * Shipping label of a Mini App order, 75×120 mm, black and white, no margins, one label per order (S2E-13).
 * Printed from the browser on the Xprinter label printer. Not for Yandex orders.
 * The customer's name, phone and address exist only on this page and on the paper.
 */
export interface OrderLabelData {
  order_number: string;
  order_date: string; // YYYY-MM-DD
  prepaid: boolean;
  recipient: { name: string; phone: string };
  address: { region: string; city: string; text: string };
  items: { sku: string; name: string; qty: number }[];
  waybill: string | null;
}

/** How many lines of the order fit above the QR code; the rest is summed up in one line. */
export const LABEL_MAX_ITEMS = 7;
const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
/** The order number always fits the 69 mm of the label in one line (monospace: a character ≈ 0.6 of the size). */
export const numberSizeMm = (n: string) => Math.min(11, Math.floor((69 / (Math.max(n.length, 6) * 0.6)) * 10) / 10);

export function OrderLabelSheet({ data }: { data: OrderLabelData }) {
  const shown = data.items.slice(0, data.items.length > LABEL_MAX_ITEMS ? LABEL_MAX_ITEMS - 1 : LABEL_MAX_ITEMS);
  const rest = data.items.slice(shown.length);
  const units = data.items.reduce((s, i) => s + i.qty, 0);
  return (
    <div className="olabel" data-testid="order-label">
      <div className="olabel-top">
        <strong>VITALO</strong>
        <span>{ruDate(data.order_date)}</span>
      </div>
      <div className="olabel-number" style={{ fontSize: `${numberSizeMm(data.order_number)}mm` }}>
        {data.order_number}
      </div>
      {data.prepaid && <div className="olabel-paid">ПРЕДОПЛАЧЕНО</div>}
      <div className="olabel-block">
        <span>Получатель</span>
        <strong>{data.recipient.name}</strong>
        <strong>{prettyPhone(data.recipient.phone)}</strong>
      </div>
      <div className="olabel-block">
        <span>Адрес доставки</span>
        <b>
          {data.address.region}, {data.address.city}
        </b>
        <div className="olabel-address">{data.address.text}</div>
      </div>
      <div className="olabel-items">
        <span>Состав: {units} шт.</span>
        {shown.map((i) => (
          <div key={i.sku} className="olabel-item">
            <b>
              {i.sku} × {i.qty}
            </b>{' '}
            {short(i.name, 34)}
          </div>
        ))}
        {rest.length > 0 && (
          <div className="olabel-item">
            …и ещё {rest.length} поз. ({rest.reduce((s, i) => s + i.qty, 0)} шт.) — см. заказ
          </div>
        )}
      </div>
      <div className="olabel-bottom">
        <QrCode value={data.order_number} sizeMm={24} />
        <div className="olabel-waybill">
          {data.waybill && (
            <>
              <span>Накладная службы доставки</span>
              <strong>{data.waybill}</strong>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const PageSize = () => <style>{'@page { size: 75mm 120mm; margin: 0; }'}</style>;

async function printWhenReady() {
  await document.fonts?.ready;
  window.setTimeout(() => window.print(), 200);
}

/** Reads the print ticket from #t=… once and removes it from the address bar and the history entry. */
function takeTicket(): string | null {
  const t = new URLSearchParams(window.location.hash.slice(1)).get('t');
  if (t) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return t;
}

const HINT = 'Печать: принтер Xprinter, бумага 75×120 мм, масштаб 100%, поля «Нет», без колонтитулов.';

/**
 * /print/order-label#t=<ticket>: opens in any browser (Chrome) without Telegram and without the staff token. The
 * ticket comes from «Печать наклейки» in the order card: this order only, 15 minutes, while the employee is signed in.
 */
export function PrintOrderLabel() {
  const [ticket] = useState(takeTicket);
  const [label, setLabel] = useState<OrderLabelData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const run = async () => {
    if (!ticket) return;
    setBusy(true);
    setError(null);
    try {
      setLabel((await api<{ label: OrderLabelData }>('/print/order-label', { method: 'POST', body: { ticket }, anonymous: true })).label);
      await printWhenReady();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (started.current) return; // once per opening (StrictMode runs effects twice in dev)
    started.current = true;
    void run();
  }, []);

  return (
    <div className="print-page">
      <PageSize />
      <div className="print-toolbar no-print">
        <strong>Наклейка заказа 75×120 мм{label ? `: ${label.order_number}` : ''}</strong>
        <button className="btn" disabled={busy || !label} onClick={() => void run()}>
          Напечатать ещё раз
        </button>
        <button className="btn btn-ghost" onClick={() => window.close()}>
          Закрыть
        </button>
        <span className="muted small">{HINT}</span>
      </div>
      {!ticket && <div className="alert alert-warn no-print">Откройте печать из админки: заказ → «Печать наклейки». Ссылка действует 15 минут.</div>}
      <div className="no-print">
        <ErrorBox error={error} />
      </div>
      <div className="labels">{label && <OrderLabelSheet data={label} />}</div>
    </div>
  );
}

const SAMPLE: OrderLabelData = {
  order_number: 'VTL-261017-0042',
  order_date: '2026-10-17',
  prepaid: true,
  recipient: { name: 'Тестовый Получатель', phone: '+998900000000' },
  address: { region: 'Ташкент', city: 'Мирзо-Улугбекский район', text: 'ул. Примерная, дом 12, квартира 34, подъезд 2, домофон 34 (данные вымышленные)' },
  items: [
    { sku: 'OZN-A001', name: 'Витамин D3 5000 МЕ, 120 капсул', qty: 2 },
    { sku: 'OZN-A023', name: 'Омега-3 рыбий жир высокой концентрации, 90 капсул', qty: 1 },
    { sku: 'SUP-B107', name: 'Магний хелат 200 мг, 100 таблеток', qty: 1 },
  ],
  waybill: 'BTS-12345678',
};

/** /print/order-test: one sample label with invented data (no sign-in, no API) — to set up the printer. */
export function TestOrderLabel() {
  return (
    <div className="print-page">
      <PageSize />
      <div className="print-toolbar no-print">
        <strong>Тестовая наклейка заказа 75×120 мм (данные вымышленные)</strong>
        <button className="btn" onClick={() => void printWhenReady()}>
          Печать
        </button>
        <span className="muted small">{HINT}</span>
      </div>
      <div className="labels">
        <OrderLabelSheet data={SAMPLE} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the block in the order card

/**
 * «Отправка» in the card of a Mini App order: «Печать наклейки» (whoever sees the order: manager, warehouse, admin)
 * and the optional waybill number of the delivery service (warehouse and admin).
 */
export function OrderShipping({ orderId, waybill, canPrint, canEdit, onSaved }: { orderId: string; waybill: string | null; canPrint: boolean; canEdit: boolean; onSaved: () => void }) {
  const [value, setValue] = useState(waybill ?? '');
  const save = useMutation({
    mutationFn: () => api(`/staff/orders/${orderId}/waybill`, { method: 'PATCH', body: { delivery_waybill: value.trim() || null } }),
    onSuccess: onSaved,
  });
  const changed = value.trim() !== (waybill ?? '');
  return (
    <section className="card">
      <h2>Отправка</h2>
      <dl className="props">
        <dt>Наклейка 75×120 мм</dt>
        <dd>
          {canPrint ? (
            <>
              <LabelLink orderId={orderId}>Печать наклейки</LabelLink>{' '}
              <a className="btn btn-sm btn-ghost" href="/print/order-test" target="_blank" rel="noopener noreferrer">
                Тестовая наклейка
              </a>
              <div className="muted small">Одна наклейка на заказ. Если ниже указан номер накладной — он тоже печатается.</div>
            </>
          ) : (
            <span className="muted">печатается после подтверждения оплаты</span>
          )}
        </dd>
        <dt>Номер накладной службы доставки</dt>
        <dd>
          {canEdit ? (
            <form
              style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
              onSubmit={(e) => {
                e.preventDefault();
                if (changed) save.mutate();
              }}
            >
              <input value={value} onChange={(e) => setValue(e.target.value)} maxLength={64} placeholder="BTS, Яндекс Go… (необязательно)" aria-label="Номер накладной службы доставки" style={{ width: 240 }} />
              <button className="btn btn-sm" disabled={!changed || save.isPending}>
                Сохранить
              </button>
            </form>
          ) : (
            (waybill ?? <span className="muted">не указан</span>)
          )}
          <ErrorBox error={save.error} />
        </dd>
      </dl>
    </section>
  );
}

/** A link to the label page with a print ticket in the #fragment (never the staff token); renewed every 5 minutes. */
function LabelLink({ orderId, children }: { orderId: string; children: ReactNode }) {
  const q = useQuery({
    queryKey: ['order-label-ticket', orderId],
    queryFn: () => api<{ ticket: string; expires_at: string }>(`/staff/orders/${orderId}/label/ticket`, { method: 'POST' }),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
  const url = q.data ? `/print/order-label#t=${encodeURIComponent(q.data.ticket)}` : undefined;
  return (
    <>
      <a
        className="btn btn-sm"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-disabled={!url}
        onClick={(e) => {
          if (!url) return e.preventDefault();
          const tg = window.Telegram?.WebApp;
          if (tg?.initData && tg.openLink) {
            e.preventDefault();
            tg.openLink(new URL(url, window.location.href).href);
          }
        }}
      >
        {children}
      </a>
      {q.error && <ErrorBox error={q.error} onRetry={() => void q.refetch()} />}
    </>
  );
}
