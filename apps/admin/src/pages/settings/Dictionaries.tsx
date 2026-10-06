import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { DICTIONARY_LABELS, dictionaryKey, useDictionary, type DictionaryKind, type DictionaryValue } from '../../components/DictionarySelect';
import { Badge, ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { api } from '../../lib/api';

/**
 * Настройки → Справочники (admin): brands, manufacturers, countries, forms.
 * Renaming a value renames it on every product that has it (the shop shows the new name).
 * Values are never deleted: an archived value is not offered for new products, products keep it.
 */
export function DictionariesSettings() {
  const [kind, setKind] = useState<DictionaryKind>('brands');
  return (
    <>
      <div className="segmented">
        {(Object.keys(DICTIONARY_LABELS) as DictionaryKind[]).map((k) => (
          <button key={k} type="button" className={kind === k ? 'is-on' : ''} onClick={() => setKind(k)}>
            {DICTIONARY_LABELS[k]}
          </button>
        ))}
      </div>
      <DictionaryList key={kind} kind={kind} />
    </>
  );
}

function DictionaryList({ kind }: { kind: DictionaryKind }) {
  const client = useQueryClient();
  const q = useDictionary(kind);
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<DictionaryValue | null>(null);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: dictionaryKey(kind) });
    void client.invalidateQueries({ queryKey: ['products'] });
  };
  const add = useMutation({
    mutationFn: () => api(`/staff/dictionaries/${kind}`, { method: 'POST', body: { name_ru: name } }),
    onSuccess: () => {
      setName('');
      refresh();
    },
  });
  const status = useMutation({
    mutationFn: (v: DictionaryValue) => api(`/staff/dictionaries/${kind}/${v.id}`, { method: 'PATCH', body: { status: v.status === 'active' ? 'archived' : 'active' } }),
    onSuccess: refresh,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) add.mutate();
  };

  return (
    <section className="card">
      <form className="filters" onSubmit={submit}>
        <input placeholder={`Новое значение: ${DICTIONARY_LABELS[kind].toLowerCase()}`} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={add.isPending || !name.trim()}>
          Добавить
        </button>
      </form>
      <ErrorBox error={add.error ?? status.error} />
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Название (RU)</th>
              <th>Название (UZ)</th>
              <th className="num">Товаров</th>
              <th>Статус</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Пока пусто
                </td>
              </tr>
            )}
            {q.data.map((v) => (
              <tr key={v.id}>
                <td className="strong">{v.name_ru}</td>
                <td>{v.name_uz ?? <span className="muted">—</span>}</td>
                <td className="num">{v.products}</td>
                <td>{v.status === 'active' ? <Badge tone="ok">Активно</Badge> : <Badge>В архиве</Badge>}</td>
                <td className="num">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEdit(v)}>
                    Переименовать
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={status.isPending}
                    onClick={() =>
                      v.status === 'active'
                        ? window.confirm(`Убрать «${v.name_ru}» в архив? У товаров значение останется, но для новых его не выбрать.`) && status.mutate(v)
                        : status.mutate(v)
                    }
                  >
                    {v.status === 'active' ? 'В архив' : 'Вернуть из архива'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <RenameModal kind={kind} value={edit} onClose={() => setEdit(null)} onDone={refresh} />}
    </section>
  );
}

function RenameModal({ kind, value, onClose, onDone }: { kind: DictionaryKind; value: DictionaryValue; onClose: () => void; onDone: () => void }) {
  const [ru, setRu] = useState(value.name_ru);
  const [uz, setUz] = useState(value.name_uz ?? '');
  const save = useMutation({
    mutationFn: () => api(`/staff/dictionaries/${kind}/${value.id}`, { method: 'PATCH', body: { name_ru: ru, name_uz: uz || null } }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal title="Переименовать" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Название (RU)" hint={value.products ? `Новое название сразу появится у ${value.products} товар(ов) в магазине` : undefined}>
          <input value={ru} onChange={(e) => setRu(e.target.value)} required />
        </Field>
        <Field label="Название (UZ)">
          <input value={uz} onChange={(e) => setUz(e.target.value)} />
        </Field>
        <ErrorBox error={save.error} />
        <button className="btn" disabled={save.isPending || !ru.trim()}>
          Сохранить
        </button>
      </form>
    </Modal>
  );
}
