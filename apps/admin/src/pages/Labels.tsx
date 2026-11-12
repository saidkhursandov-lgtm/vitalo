import qrcode from 'qrcode-generator';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorBox } from '../components/ui';
import { api } from '../lib/api';
import { encodeCode128 } from '../lib/code128';
import { ruDate } from '../lib/format';

/**
 * Physical ID labels 58×40 mm for XPrinter XP-365B (203 DPI, print width up to 76 mm), printed from the browser:
 * one label per page, 2 mm safe margins. On the label: Physical ID (large, monospace), SKU, expiry date and a QR
 * code holding only the Physical ID. Never the product name, composition, order numbers, price or cost (S2B-2).
 * The paper size is a setting (Настройки → Печать, /staff/settings/label-size), 58×40 by default.
 */
export interface LabelData {
  id?: string;
  physical_id: string;
  sku: string;
  expiry_date: string; // YYYY-MM-DD
}

export interface LabelSize {
  width_mm: number;
  height_mm: number;
}

export const DEFAULT_LABEL_SIZE: LabelSize = { width_mm: 58, height_mm: 40 };

/** Physical ID characters (V, digits, «-») fit the compact alphanumeric QR mode: version 1, 21×21 modules. */
const QR_ALNUM = /^[0-9A-Z $%*+\-./:]+$/;
const QR_QUIET = 2; // modules; the label's own 2 mm white margin adds to it

/** QR code built locally (qrcode-generator), as crisp SVG squares. Encodes only `value`. */
export function QrCode({ value, sizeMm }: { value: string; sizeMm: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(value, QR_ALNUM.test(value) ? 'Alphanumeric' : 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + QR_QUIET} ${r + QR_QUIET}h1v1h-1z`;
  const box = n + 2 * QR_QUIET;
  return (
    <svg
      className="idlabel-qr"
      viewBox={`0 0 ${box} ${box}`}
      style={{ width: `${sizeMm}mm`, height: `${sizeMm}mm` }}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`QR ${value}`}
      data-modules={n}
    >
      <path d={d} fill="#000" />
    </svg>
  );
}

/** 58×40 is the design size; other sizes from the setting scale the same layout. */
const scaleOf = (s: LabelSize) => Math.min(s.width_mm / 58, s.height_mm / 40);

export function Label({ data, size = DEFAULT_LABEL_SIZE }: { data: LabelData; size?: LabelSize }) {
  const k = scaleOf(size);
  const style = { width: `${size.width_mm}mm`, height: `${size.height_mm}mm`, '--k': k } as CSSProperties;
  return (
    <div className="idlabel" data-testid="label" style={style}>
      <div className="idlabel-id">{data.physical_id}</div>
      <div className="idlabel-row">
        <div className="idlabel-text">
          <div className="idlabel-sku">{data.sku}</div>
          <div className="idlabel-exp">
            <span>Годен до / Yaroqli:</span>
            <strong>{ruDate(data.expiry_date)}</strong>
          </div>
        </div>
        <QrCode value={data.physical_id} sizeMm={Math.round(22 * k * 10) / 10} />
      </div>
    </div>
  );
}

/** Only on the print pages: the paper size of the label printer, no browser margins. */
const PageSize = ({ size }: { size: LabelSize }) => <style>{`@page { size: ${size.width_mm}mm ${size.height_mm}mm; margin: 0; }`}</style>;

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

/**
 * /print/labels#t=<ticket>: opens in any browser (Chrome) without Telegram and without the staff token. The ticket
 * comes from «Напечатать этикетки» in the admin panel: it allows printing only these labels, for 15 minutes, while
 * the employee's session is valid. Opening records the print (LABEL_PRINTED, label_print_count + 1) and opens
 * the print dialog; «Напечатать ещё раз» records it again.
 */
export function PrintLabels() {
  const [ticket] = useState(takeTicket);
  const [res, setRes] = useState<{ labels: LabelData[]; label_size: LabelSize; warnings: string[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const size = res?.label_size ?? DEFAULT_LABEL_SIZE;

  const run = async () => {
    if (!ticket) return;
    setBusy(true);
    setError(null);
    try {
      setRes(await api('/print/labels', { method: 'POST', body: { ticket }, anonymous: true }));
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
      <PageSize size={size} />
      <div className="print-toolbar no-print">
        <strong>
          Этикетки {size.width_mm}×{size.height_mm} мм{res ? `: ${res.labels.length} шт.` : ''}
        </strong>
        <button className="btn" disabled={busy || !res} onClick={() => void run()}>
          Напечатать ещё раз
        </button>
        <button className="btn btn-ghost" onClick={() => window.close()}>
          Закрыть
        </button>
        <span className="muted small">
          Печать: принтер XP-365B, бумага {size.width_mm}×{size.height_mm} мм, масштаб 100%, поля «Нет», без колонтитулов.
        </span>
      </div>
      {!ticket && (
        <div className="alert alert-warn no-print">Откройте печать из админки: Склад → Приёмка → «Напечатать этикетки». Ссылка действует 15 минут.</div>
      )}
      {res?.warnings.map((w) => (
        <div key={w} className="alert alert-warn no-print">
          {w}
        </div>
      ))}
      <div className="no-print">
        <ErrorBox error={error} />
      </div>
      <div className="labels">{res?.labels.map((l) => <Label key={l.id ?? l.physical_id} data={l} size={size} />)}</div>
    </div>
  );
}

const SAMPLES: LabelData[] = [
  { physical_id: 'V-000184', sku: 'OZN-A001', expiry_date: '2027-12-31' },
  { physical_id: 'V-000185', sku: 'OZN-A023', expiry_date: '2028-03-15' },
  { physical_id: 'V-012345', sku: 'SUP-B107', expiry_date: '2027-06-01' },
];

/** Size from ?w=58&h=40 (the admin panel passes the setting), otherwise 58×40. */
function sizeFromQuery(params: URLSearchParams): LabelSize {
  const w = Number(params.get('w'));
  const h = Number(params.get('h'));
  return w >= 30 && w <= 76 && h >= 20 && h <= 120 ? { width_mm: w, height_mm: h } : DEFAULT_LABEL_SIZE;
}

/**
 * /print/test: sample labels with fake data and calibration marks (page edge, 2 mm safe area, 10 mm ticks).
 * Opens without signing in: it has no real data and calls no API.
 */
export function TestPrint() {
  const [params] = useSearchParams();
  const size = sizeFromQuery(params);
  const [marks, setMarks] = useState(true);
  return (
    <div className="print-page">
      <PageSize size={size} />
      <div className="print-toolbar no-print">
        <strong>Тестовая печать: 3 примера этикетки (данные вымышленные)</strong>
        <label className="check">
          <input type="checkbox" checked={marks} onChange={(e) => setMarks(e.target.checked)} /> Разметка для калибровки
        </label>
        <button className="btn" onClick={() => void printWhenReady()}>
          Печать
        </button>
        <span className="muted small">
          Сплошная рамка — край этикетки {size.width_mm}×{size.height_mm} мм, пунктир — безопасное поле 2 мм, риски — каждые 10 мм. Подробно — в инструкции по печати этикеток.
        </span>
      </div>
      <div className="labels">
        {SAMPLES.map((s) => (
          <div key={s.physical_id} className={marks ? 'calib' : 'calib-off'}>
            <Label data={s} size={size} />
            {marks && (
              <div className="calib-marks" aria-hidden>
                <span className="calib-safe" />
                {Array.from({ length: Math.floor((size.width_mm - 1) / 10) }, (_, i) => (
                  <span key={`x${i}`} className="calib-tick calib-tick-x" style={{ left: `${(i + 1) * 10}mm` }} />
                ))}
                {Array.from({ length: Math.floor((size.height_mm - 1) / 10) }, (_, i) => (
                  <span key={`y${i}`} className="calib-tick calib-tick-y" style={{ top: `${(i + 1) * 10}mm` }} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 75×120 template (not used yet)

/**
 * The former 75×120 mm label (Physical ID, Code 128 barcode, SKU, short composition RU/UZ, expiry). Not used for
 * Physical ID any more; kept as a template for a future courier-bag label. Nothing renders it now.
 */
export interface Label75x120Data extends LabelData {
  composition_ru?: string | null;
  composition_uz?: string | null;
}

/** One module = 3 printer dots at 203 DPI (0.375 mm): wide enough for any scanner, «V-000184» ≈ 54 mm with margins. */
const MODULE_MM = (3 * 25.4) / 203;
const QUIET = 10; // blank modules on each side

export function Barcode({ value, heightMm = 16 }: { value: string; heightMm?: number }) {
  const bits = encodeCode128(value);
  const width = bits.length + 2 * QUIET;
  const bars: { x: number; w: number }[] = [];
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== '1') continue;
    const start = i;
    while (bits[i + 1] === '1') i++;
    bars.push({ x: QUIET + start, w: i - start + 1 });
  }
  return (
    <svg
      className="label-barcode"
      viewBox={`0 0 ${width} 100`}
      preserveAspectRatio="none"
      style={{ width: `${(width * MODULE_MM).toFixed(2)}mm`, height: `${heightMm}mm` }}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`Штрихкод ${value}`}
    >
      {bars.map((b) => (
        <rect key={b.x} x={b.x} y={0} width={b.w} height={100} fill="#000" />
      ))}
    </svg>
  );
}

export function Label75x120({ data }: { data: Label75x120Data }) {
  return (
    <div className="label" data-testid="label-75x120">
      <div className="label-id">{data.physical_id}</div>
      <Barcode value={data.physical_id} />
      <div className="label-sku">SKU: {data.sku}</div>
      <div className="label-comp">
        <p>
          <b>Состав:</b> {data.composition_ru || '—'}
        </p>
        <p>
          <b>Tarkibi:</b> {data.composition_uz || '—'}
        </p>
      </div>
      <div className="label-exp">
        <span>Срок годности / Yaroqlilik muddati:</span>
        <strong>{ruDate(data.expiry_date)}</strong>
      </div>
    </div>
  );
}
