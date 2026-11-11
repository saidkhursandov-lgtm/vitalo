import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Badge, ErrorBox } from './ui';

/**
 * Аудит 10.11, п. 1.5: отметка «Тестовая запись» у товара, бренда, закупки или клиента. Такие записи не удаляются,
 * а скрываются в списках по умолчанию и не входят в сводки. Ставит и снимает только администратор; остальные
 * видят только значок «Тест».
 */
export function TestFlag({ entity, id, value, invalidate }: { entity: 'product' | 'brand' | 'purchase' | 'customer'; id: string; value: boolean; invalidate: unknown[] }) {
  const { can } = useSession();
  const client = useQueryClient();
  const m = useMutation({
    mutationFn: (is_test: boolean) => api(`/staff/test-flags/${entity}/${id}`, { method: 'PATCH', body: { is_test } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: invalidate }),
  });
  if (!can('test_flags.manage')) return value ? <Badge tone="warn">Тест</Badge> : null;
  return (
    <span>
      <label className="check" title="Тестовые записи скрыты в списках и не входят в сводки">
        <input type="checkbox" checked={value} disabled={m.isPending} onChange={(e) => m.mutate(e.target.checked)} />
        Тестовая запись
      </label>
      <ErrorBox error={m.error} />
    </span>
  );
}

/** «Показать тестовые» for a list: tests are hidden unless ?show_test=true; returns the API flag and the checkbox. */
export function useShowTest() {
  const [params, setParams] = useSearchParams();
  const show = params.get('show_test') === 'true';
  const toggle = (
    <label className="check">
      <input
        type="checkbox"
        checked={show}
        onChange={(e) => {
          const next = new URLSearchParams(params);
          next.delete('page');
          if (e.target.checked) next.set('show_test', 'true');
          else next.delete('show_test');
          setParams(next, { replace: true });
        }}
      />
      Показать тестовые
    </label>
  );
  return { hideTest: !show, toggle };
}
