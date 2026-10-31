import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, apiBlob } from '../lib/api';
import { dateTime } from '../lib/format';
import { Badge, ErrorBox } from './ui';

interface Receipt {
  id: string;
  mime: string;
  size_bytes: number;
  status: 'pending' | 'confirmed' | 'rejected';
  reject_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

const STATUS = {
  pending: { tone: 'warn', text: 'Ждёт проверки' },
  confirmed: { tone: 'ok', text: 'Оплата подтверждена' },
  rejected: { tone: 'bad', text: 'Отклонён' },
} as const;

/** The picture itself, loaded with the staff token (the file is private: names, card numbers). */
function ReceiptFile({ orderId, receipt }: { orderId: string; receipt: Receipt }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let made: string | null = null;
    apiBlob(`/staff/orders/${orderId}/receipts/${receipt.id}/file`)
      .then((b) => setUrl((made = URL.createObjectURL(b))))
      .catch(() => setFailed(true));
    return () => {
      if (made) URL.revokeObjectURL(made);
    };
  }, [orderId, receipt.id]);
  if (failed) return <p className="muted small">Файл не открылся</p>;
  if (!url) return <p className="muted small">Загружаем…</p>;
  return receipt.mime === 'application/pdf' ? (
    <a className="btn btn-ghost" href={url} target="_blank" rel="noreferrer">
      Открыть PDF
    </a>
  ) : (
    <a href={url} target="_blank" rel="noreferrer" title="Открыть в полном размере">
      <img className="receipt-img" src={url} alt="Чек об оплате" />
    </a>
  );
}

/**
 * 3.1: receipts the customer sent to the bot. Confirming is the usual «Подтвердить оплату» button above (the bot has
 * the same buttons); a rejection is made in the bot, where the manager picks or types the reason.
 */
export function OrderReceipts({ orderId }: { orderId: string }) {
  const q = useQuery({ queryKey: ['order-receipts', orderId], queryFn: () => api<Receipt[]>(`/staff/orders/${orderId}/receipts`) });
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data?.length) return null;
  return (
    <section className="card">
      <h2>Чеки клиента ({q.data.length})</h2>
      <ul className="receipts">
        {q.data.map((r) => (
          <li key={r.id}>
            <div className="receipt-meta">
              <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].text}</Badge>
              <span className="muted small">Прислан {dateTime(r.created_at)}</span>
              {r.reviewed_by && (
                <span className="muted small">
                  {r.status === 'rejected' ? 'Отклонил' : 'Проверил'}: {r.reviewed_by}, {dateTime(r.reviewed_at)}
                </span>
              )}
              {r.reject_reason && <span className="small">Причина: {r.reject_reason}</span>}
            </div>
            <ReceiptFile orderId={orderId} receipt={r} />
          </li>
        ))}
      </ul>
    </section>
  );
}
