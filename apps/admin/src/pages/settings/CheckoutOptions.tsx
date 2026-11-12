import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { ErrorBox, Field, Loading } from '../../components/ui';
import { api } from '../../lib/api';
import { money } from '../../lib/format';

type Provider = 'payme' | 'click' | 'uzum';
type Mode = 'hidden' | 'soon' | 'test' | 'live';
type Modes = Record<Provider, Mode>;

interface Options {
  cod_max_total_uzs: number | null;
  show_online_soon: boolean;
  first_order_free_delivery: boolean;
  online: Modes;
  /** What is missing for «Работает» (only yes / no, never the keys themselves). */
  online_status: Record<Provider, { keys_present: boolean; module_ready: boolean; can_go_live: boolean }>;
}

const PROVIDERS: [Provider, string][] = [
  ['payme', 'Payme'],
  ['click', 'Click'],
  ['uzum', 'Uzum'],
];
const MODES: [Mode, string][] = [
  ['hidden', 'Скрыта'],
  ['soon', 'Скоро'],
  ['test', 'Тест (сотрудники)'],
  ['live', 'Работает'],
];

/** Why «Работает» cannot be chosen yet, in plain words. */
function liveBlocker(s: Options['online_status'][Provider]): string | null {
  if (s.can_go_live) return null;
  const missing = [!s.keys_present && 'ключей подключения на сервере', !s.module_ready && 'модуля подключения'].filter(Boolean);
  return `«Тест» и «Работает» пока нельзя: нет ${missing.join(' и ')}.`;
}

/**
 * Release 1: «Оплата при получении» (the limit) and free delivery of the first order.
 * 2.1 (D-20): Payme / Click / Uzum each «Скрыта / Скоро / Работает»; «Работает» only with keys and a module.
 */
export function CheckoutOptions() {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'checkout'], queryFn: () => api<Options>('/staff/settings/checkout-options') });
  const [limit, setLimit] = useState('');
  const [modes, setModes] = useState<Modes>({ payme: 'soon', click: 'soon', uzum: 'soon' });
  const [freeFirst, setFreeFirst] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setLimit(q.data.cod_max_total_uzs == null ? '' : String(q.data.cod_max_total_uzs));
    setModes(q.data.online);
    setFreeFirst(q.data.first_order_free_delivery);
  }, [q.data]);

  const digits = limit.replace(/\s/g, '');
  const valid = digits === '' || (/^\d+$/.test(digits) && Number(digits) >= 1 && Number(digits) <= 1_000_000_000);
  const save = useMutation({
    // an empty field means «no limit» and is sent as null
    mutationFn: () =>
      api<Options>('/staff/settings/checkout-options', {
        method: 'PUT',
        body: { cod_max_total_uzs: digits === '' ? null : Number(digits), first_order_free_delivery: freeFirst, online: modes },
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
  const status = q.data.online_status;

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

      <h2 style={{ marginTop: 20 }}>Онлайн-оплата: Payme, Click, Uzum</h2>
      <p className="muted small">
        «Скрыта» — клиент её не видит. «Скоро» — логотип при оформлении; нажатие объясняет, что оплата скоро заработает, и считается в «Аналитика → Воронка». «Тест (сотрудники)» — настоящая оплата только для сотрудников (их Telegram есть в «Сотрудниках»), покупатели видят «Скоро»: так проверяют оплату на боевом сервере. «Работает» — настоящая оплата для всех. «Тест» и «Работает» — только когда есть ключи и модуль подключения.
      </p>
      {PROVIDERS.map(([p, name]) => {
        const blocker = liveBlocker(status[p]);
        return (
          <div key={p} className="online-mode">
            <strong>{name}</strong>
            <div className="segmented" role="radiogroup" aria-label={name}>
              {MODES.map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={modes[p] === m}
                  className={modes[p] === m ? 'is-on' : ''}
                  disabled={(m === 'live' || m === 'test') && !!blocker && modes[p] !== m}
                  title={(m === 'live' || m === 'test') && blocker ? blocker : undefined}
                  onClick={() => (setModes({ ...modes, [p]: m }), setSaved(false))}
                >
                  {label}
                </button>
              ))}
            </div>
            {blocker && <p className="muted small online-mode-why">{blocker}</p>}
          </div>
        );
      })}

      <ErrorBox error={save.error} />
      {saved && <div className="alert alert-ok">Сохранено</div>}
      <button className="btn" disabled={save.isPending || !valid}>
        Сохранить
      </button>
    </form>
  );
}
