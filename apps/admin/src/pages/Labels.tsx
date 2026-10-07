import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorBox } from '../components/ui';
import { api } from '../lib/api';
import { encodeCode128 } from '../lib/code128';
import { ruDate } from '../lib/format';

/**
 * Stage 2B labels 75×120 mm for XPrinter XP-365B (print width 76 mm, 203 DPI), printed from the browser:
 * one label per page, portrait, 2 mm safe margins. On the label: Physical ID, its Code 128 barcode, SKU,
 * short composition RU/UZ and the expiry date. Never the product name or order numbers (S2B-2).
 */
export interface LabelData {
  id?: string;
  physical_id: string;
  sku: string;
  composition_ru: string | null;
  composition_uz: string | null;
  expiry_date: string; // YYYY-MM-DD
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

export function Label({ data }: { data: LabelData }) {
  return (
    <div className="label" data-testid="label">
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

/** Only on the print pages: the paper size of the label printer. */
const PageSize = () => <style>{'@page { size: 75mm 120mm; margin: 0; }'}</style>;

async function printWhenReady() {
  await document.fonts?.ready;
  window.setTimeout(() => window.print(), 200);
}

/**
 * /print/labels?session=<id> | ?units=<id>,<id>: opening the page records the print (LABEL_PRINTED,
 * label_print_count + 1) and opens the print dialog. «Напечатать ещё раз» records it again.
 */
export function PrintLabels() {
  const [params] = useSearchParams();
  const session = params.get('session');
  const units = (params.get('units') ?? '').split(',').filter(Boolean);
  const [res, setRes] = useState<{ labels: LabelData[]; warnings: string[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = session ? { session_id: session } : { unit_ids: units };
      setRes(await api<{ labels: LabelData[]; warnings: string[] }>('/staff/units/labels', { method: 'POST', body }));
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
        <strong>Этикетки 75×120 мм{res ? `: ${res.labels.length} шт.` : ''}</strong>
        <button className="btn" disabled={busy || !res} onClick={() => void run()}>
          Напечатать ещё раз
        </button>
        <button className="btn btn-ghost" onClick={() => window.close()}>
          Закрыть
        </button>
        <span className="muted small">Печать: принтер XP-365B, бумага 75×120, масштаб 100%, без полей и колонтитулов.</span>
      </div>
      {res?.warnings.map((w) => (
        <div key={w} className="alert alert-warn no-print">
          {w}
        </div>
      ))}
      <div className="no-print">
        <ErrorBox error={error} />
      </div>
      <div className="labels">{res?.labels.map((l) => <Label key={l.id ?? l.physical_id} data={l} />)}</div>
    </div>
  );
}

const SAMPLE: LabelData = {
  physical_id: 'V-012345',
  sku: 'TEST-SKU-001',
  composition_ru: 'Рыбий жир (омега-3) 1000 мг, желатин, глицерин, вода очищенная, витамин E.',
  composition_uz: 'Baliq yog‘i (omega-3) 1000 mg, jelatin, glitserin, tozalangan suv, E vitamini. G‘o‘za — o‘ g‘ tekshiruvi.',
  expiry_date: '2027-12-31',
};

/** /print/test: a sample label with fake data and calibration marks (page edge, 2 mm safe area, 10 mm ticks). */
export function TestPrint() {
  const [marks, setMarks] = useState(true);
  return (
    <div className="print-page">
      <PageSize />
      <div className="print-toolbar no-print">
        <strong>Тестовая печать: пример этикетки (данные вымышленные)</strong>
        <label className="check">
          <input type="checkbox" checked={marks} onChange={(e) => setMarks(e.target.checked)} /> Разметка для калибровки
        </label>
        <button className="btn" onClick={() => void printWhenReady()}>
          Печать
        </button>
        <span className="muted small">
          Сплошная рамка — край этикетки 75×120 мм, пунктир — безопасное поле 2 мм, риски — каждые 10 мм. Подробно: docs/PRINT_SETUP.md.
        </span>
      </div>
      <div className="labels">
        <div className={marks ? 'calib' : ''}>
          <Label data={SAMPLE} />
          {marks && (
            <div className="calib-marks" aria-hidden>
              <span className="calib-safe" />
              {Array.from({ length: 7 }, (_, i) => (
                <span key={`x${i}`} className="calib-tick calib-tick-x" style={{ left: `${(i + 1) * 10}mm` }} />
              ))}
              {Array.from({ length: 11 }, (_, i) => (
                <span key={`y${i}`} className="calib-tick calib-tick-y" style={{ top: `${(i + 1) * 10}mm` }} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
