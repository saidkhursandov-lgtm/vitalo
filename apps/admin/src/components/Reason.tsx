import { useState } from 'react';
import { Field } from './ui';

const OTHER = '__other';

/** Ready-made reasons per action (the server only needs a text of 3+ characters). */
export const REASONS = {
  cancel: ['Покупатель отменил заказ на Яндексе', 'Яндекс отменил заказ', 'Нет товара / ошибка в заказе'],
  return: ['Покупатель не забрал заказ', 'Покупатель вернул после доставки', 'Курьер вернул: повреждение в пути'],
  fefo: ['Банка с ближним сроком повреждена', 'Банка с ближним сроком не найдена на полке', 'Ближний срок слишком короткий для покупателя'],
  missing: ['Не нашли на полке при пересчёте', 'Не нашли при сборке заказа'],
  found: ['Нашли на другой полке', 'Нашли при пересчёте'],
  writeoff: ['Истёк срок годности', 'Банка повреждена', 'Банка вскрыта'],
  accept: ['Банка целая, срок в порядке'],
  returnWriteoff: ['Банка вскрыта', 'Банка повреждена', 'Истёк или скоро истечёт срок'],
  correct: ['Опечатка при приёмке', 'Ошибочно списали / отметили не ту банку'],
} as const;

/** Reason: a list of ready answers plus «Другое» with free text. Calls onChange with the final text ('' = not chosen). */
export function ReasonPicker({ options, onChange, label = 'Причина' }: { options: readonly string[]; onChange: (reason: string) => void; label?: string }) {
  const [choice, setChoice] = useState('');
  const [other, setOther] = useState('');
  const emit = (c: string, o: string) => onChange(c === OTHER ? o.trim() : c);
  return (
    <>
      <Field label={label}>
        <select
          value={choice}
          onChange={(e) => {
            setChoice(e.target.value);
            emit(e.target.value, other);
          }}
          required
        >
          <option value="">— выберите —</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
          <option value={OTHER}>Другое (написать)</option>
        </select>
      </Field>
      {choice === OTHER && (
        <Field label="Ваша причина" hint="Не короче 3 символов">
          <input
            value={other}
            maxLength={300}
            autoFocus
            onChange={(e) => {
              setOther(e.target.value);
              emit(choice, e.target.value);
            }}
          />
        </Field>
      )}
    </>
  );
}
