import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { ErrorBox, Field, Loading } from '../../components/ui';
import { api } from '../../lib/api';
import { money } from '../../lib/format';

interface Options {
  cod_max_total_uzs: number | null;
  show_online_soon: boolean;
  first_order_free_delivery: boolean;
}

/** Release 1: «Оплата при получении» (the limit), «Скоро» for Payme / Click / Uzum, free delivery of the first order. */
export function CheckoutOptions() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'checkout'], queryFn: () => api<Options>('/staff/settings/checkout-options') });
  const [limit, setLimit] = useState('');
  const [soon, setSoon] = useState(false);
  const [freeFirst, setFreeFirst] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setLimit(q.data.cod_max_total_uzs == null ? '' : String(q.data.cod_max_total_uzs));
    setSoon(q.data.show_online_soon);
    setFreeFirst(q.data.first_order_free_delivery);
  }, [q.data]);

  const digits = limit.replace(/\s/g, '');
  const valid = digits === '' || (/^\d+$/.test(digits) && Number(digits) >= 1 && Number(digits) <= 1_000_000_000);
  const save = useMutation({
    // an empty field means «no limit» and is sent as null
    mutationFn: () =>
      api<Options>('/staff/settings/checkout-options', {
        method: 'PUT',
        body: { cod_max_total_uzs: digits === '' ? null : Number(digits), show_online_soon: soon, first_order_free_delivery: freeFirst },
      }),
    onSuccess: (o) => {
      client.setQueryData(['settings', 'checkout'], o);
      setSaved(true);
    },
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) save.mutate();
  };

  return (
    <form className="card narrow" onSubmit={submit}>
      <h2>Оплата при получении и доставка</h2>
      <p className="muted">«Оплата при получении» доступна клиенту только в г. Ташкент (не в Ташкентской области).</p>
      <Field label="Максимальная сумма заказа для оплаты при получении, сум" hint="Пусто — без ограничения. Сумма считается вместе с доставкой.">
        <input
          value={limit}
          inputMode="numeric"
          placeholder="без ограничения"
          onChange={(e) => (setLimit(e.target.value), setSaved(false))}
          aria-invalid={!valid}
        />
      </Field>
      {!valid && <div className="alert alert-warn">Введите целое число от 1 до 1 000 000 000 или оставьте поле пустым.</div>}
      {valid && digits !== '' && <p className="muted small">Заказы дороже {money(Number(digits))} оплатить при получении нельзя.</p>}
      <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
        <input type="checkbox" checked={freeFirst} onChange={(e) => (setFreeFirst(e.target.checked), setSaved(false))} /> Бесплатная доставка первого заказа клиента
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
        <input type="checkbox" checked={soon} onChange={(e) => (setSoon(e.target.checked), setSaved(false))} /> Показывать Payme / Click / Uzum как «Скоро» (пока нет ключей)
      </label>
      <ErrorBox error={save.error} />
      {saved && <div className="alert alert-ok">Сохранено</div>}
      <button className="btn" disabled={save.isPending || !valid}>
        Сохранить
      </button>
    </form>
  );
}
