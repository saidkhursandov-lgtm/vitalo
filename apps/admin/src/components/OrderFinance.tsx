import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { Badge, ErrorBox, toInt } from './ui';

/** «ТЕСТ» next to an order number (list and card of both channels). */
export const TestBadge = ({ show }: { show: boolean | undefined }) => (show ? <Badge tone="warn">ТЕСТ</Badge> : null);

/**
 * Stage 3, admin only (rendered when the card came with the finance data): the test flag and «Реальные расходы на
 * доставку (наши)» of an order of either channel. Every change is written to the audit log by the server.
 */
export function OrderFinance({ channel, id, isTest, ownDelivery, onDone }: { channel: 'vitalo' | 'yandex'; id: string; isTest: boolean; ownDelivery: number; onDone: () => void }) {
  const [cost, setCost] = useState(String(ownDelivery));
  const save = useMutation({
    mutationFn: (body: { is_test?: boolean; own_delivery_cost_uzs?: number }) => api(`/staff/finance/${channel === 'yandex' ? 'yandex-orders' : 'orders'}/${id}`, { method: 'PATCH', body }),
    onSuccess: onDone,
  });
  const value = toInt(cost);
  const valid = value !== undefined && Number.isInteger(value) && value >= 0;
  return (
    <section className="card">
      <h2>Финансы заказа</h2>
      <p className="muted small">Видит и меняет только администратор.</p>
      <ErrorBox error={save.error} />
      <dl className="props">
        <dt>Тестовый заказ</dt>
        <dd>
          {isTest ? <Badge tone="warn">ТЕСТ — не входит в аналитику и налог</Badge> : 'нет — заказ учитывается в аналитике и налоге'}{' '}
          <button className="btn btn-sm btn-ghost" disabled={save.isPending} onClick={() => save.mutate({ is_test: !isTest })}>
            {isTest ? 'Снять пометку «тест»' : 'Пометить тестовым'}
          </button>
        </dd>
        <dt>Реальные расходы на доставку (наши)</dt>
        <dd>
          <form
            style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) save.mutate({ own_delivery_cost_uzs: value });
            }}
          >
            <input inputMode="numeric" value={cost} onChange={(e) => setCost(e.target.value)} aria-label="Реальные расходы на доставку, сум" style={{ width: 140 }} />
            <span className="muted">сум</span>
            <button className="btn btn-sm" disabled={!valid || value === ownDelivery || save.isPending}>
              Сохранить
            </button>
            <span className="muted small">сейчас: {money(ownDelivery)}</span>
          </form>
          {channel === 'vitalo' && <div className="muted small">Доставка, которую оплатил клиент, сюда не входит: это не выручка и не расход.</div>}
        </dd>
      </dl>
    </section>
  );
}
