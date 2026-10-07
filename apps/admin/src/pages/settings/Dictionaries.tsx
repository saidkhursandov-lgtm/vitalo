import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  DICTIONARY_LABELS,
  dictionaryKey,
  isPurchaseDictionary,
  useDictionary,
  type AnyDictionaryKind,
  type DictionaryValue,
} from '../../components/DictionarySelect';
import { Badge, ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { api } from '../../lib/api';

/**
 * Настройки → Справочники (admin): brands, manufacturers, countries, forms; since stage 2A also suppliers and
 * Ozon accounts. Renaming a product value renames it on every product that has it (the shop shows the new name).
 * Values are never deleted: an archived value is not offered for new choices, what already uses it keeps it.
 */
export function DictionariesSettings() {
  const [kind, setKind] = useState<AnyDictionaryKind>('brands');
  return (
    <>
      <div className="segmented">
        {(Object.keys(DICTIONARY_LABELS) as AnyDictionaryKind[]).map((k) => (
          <button key={k} type="button" className={kind === k ? 'is-on' : ''} onClick={() => setKind(k)}>
            {DICTIONARY_LABELS[k]}
          </button>
        ))}
      </div>
      <DictionaryList key={kind} kind={kind} />
    </>
  );
}

function DictionaryList({ kind }: { kind: AnyDictionaryKind }) {
  const client = useQueryClient();
  const q = useDictionary(kind);
  const purchase = isPurchaseDictionary(kind);
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<DictionaryValue | null>(null);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: dictionaryKey(kind) });
    void client.invalidateQueries({ queryKey: [purchase ? 'purchases' : 'products'] });
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
  const usedBy = purchase ? 'закупок' : 'товаров';

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
              <th>{purchase ? 'Название' : 'Название (RU)'}</th>
              <th>{kind === 'suppliers' ? 'Заметка' : purchase ? '' : 'Название (UZ)'}</th>
              <th className="num">{purchase ? 'Закупок' : 'Товаров'}</th>
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
                <td>{kind === 'suppliers' ? (v.note ?? <span className="muted">—</span>) : purchase ? null : (v.name_uz ?? <span className="muted">—</span>)}</td>
                <td className="num">{v.products}</td>
                <td>{v.status === 'active' ? <Badge tone="ok">Активно</Badge> : <Badge>В архиве</Badge>}</td>
                <td className="num">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEdit(v)}>
                    {kind === 'suppliers' ? 'Изменить' : 'Переименовать'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={status.isPending}
                    onClick={() =>
                      v.status === 'active'
                        ? window.confirm(`Убрать «${v.name_ru}» в архив? У ${usedBy} значение останется, но для новых его не выбрать.`) && status.mutate(v)
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

function RenameModal({ kind, value, onClose, onDone }: { kind: AnyDictionaryKind; value: DictionaryValue; onClose: () => void; onDone: () => void }) {
  const purchase = isPurchaseDictionary(kind);
  const [ru, setRu] = useState(value.name_ru);
  const [uz, setUz] = useState(value.name_uz ?? '');
  const [note, setNote] = useState(value.note ?? '');
  const save = useMutation({
    mutationFn: () =>
      api(`/staff/dictionaries/${kind}/${value.id}`, {
        method: 'PATCH',
        body: purchase ? { name_ru: ru, ...(kind === 'suppliers' && { note: note || null }) } : { name_ru: ru, name_uz: uz || null },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal title={kind === 'suppliers' ? 'Изменить поставщика' : 'Переименовать'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field
          label={purchase ? 'Название' : 'Название (RU)'}
          hint={!purchase && value.products ? `Новое название сразу появится у ${value.products} товар(ов) в магазине` : undefined}
        >
          <input value={ru} onChange={(e) => setRu(e.target.value)} required />
        </Field>
        {!purchase && (
          <Field label="Название (UZ)">
            <input value={uz} onChange={(e) => setUz(e.target.value)} />
          </Field>
        )}
        {kind === 'suppliers' && (
          <Field label="Заметка" hint="Контакты, условия — видно только в админке">
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
        <ErrorBox error={save.error} />
        <button className="btn" disabled={save.isPending || !ru.trim()}>
          Сохранить
        </button>
      </form>
    </Modal>
  );
}
