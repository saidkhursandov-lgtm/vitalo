import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  DICTIONARY_LABELS,
  dictionaryKey,
  isPurchaseDictionary,
  useDictionary,
  type AnyDictionaryKind,
  type DictionaryKind,
  type DictionaryValue,
} from '../../components/DictionarySelect';
import { Badge, ErrorBox, Field, Loading, Modal, toInt } from '../../components/ui';
import { SUPPLIER_DEFAULT_TERMS, SUPPLIER_KIND_LABELS, supplierTerms, type Supplier, type SupplierKind } from '../../components/SupplierTabs';
import { api } from '../../lib/api';
import { Link } from 'react-router-dom';

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
      {kind === 'brands' ? (
        // аудит 4.6: one page for brands — name, logo, address, the showcase, «Объединить»
        <section className="card">
          <p>
            Бренды теперь в одном месте: <Link to="/brands">Каталог → Бренды</Link> — название (RU/UZ), логотип, адрес, лента брендов, «Объединить» дубли и
            архив.
          </p>
        </section>
      ) : (
        <DictionaryList key={kind} kind={kind} />
      )}
    </>
  );
}

function DictionaryList({ kind }: { kind: AnyDictionaryKind }) {
  const client = useQueryClient();
  const q = useDictionary(kind);
  const purchase = isPurchaseDictionary(kind);
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<DictionaryValue | null>(null);
  const [merging, setMerging] = useState<DictionaryValue | null>(null);
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
              <th>{kind === 'suppliers' ? 'Тип и срок под заказ' : purchase ? '' : 'Название (UZ)'}</th>
              {kind === 'suppliers' && <th className="num">Товаров</th>}
              <th className="num">{purchase ? 'Закупок' : 'Товаров'}</th>
              <th>Статус</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.length === 0 && (
              <tr>
                <td colSpan={kind === 'suppliers' ? 6 : 5} className="muted">
                  Пока пусто
                </td>
              </tr>
            )}
            {q.data.map((v) => (
              <tr key={v.id}>
                <td className="strong">{v.name_ru}</td>
                <td>
                  {kind === 'suppliers' ? <SupplierSummary s={v as Supplier} /> : purchase ? null : (v.name_uz ?? <span className="muted" title="Пусто — в магазине на узбекском показывается русское название">как RU</span>)}
                </td>
                {kind === 'suppliers' && <td className="num">{(v as Supplier).product_count}</td>}
                <td className="num">{v.products}</td>
                <td>{v.status === 'active' ? <Badge tone="ok">Активно</Badge> : <Badge>В архиве</Badge>}</td>
                <td className="num">
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEdit(v)}>
                    {kind === 'suppliers' ? 'Изменить' : 'Переименовать'}
                  </button>
                  {!purchase && v.status === 'active' && (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMerging(v)}>
                      Объединить
                    </button>
                  )}
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
      {merging && <MergeModal kind={kind as DictionaryKind} value={merging} onClose={() => setMerging(null)} onDone={refresh} />}
    </section>
  );
}

/** D-61: «Из-за рубежа · из США · 7–14 дн., гарантия 21 дн.» and the note. */
function SupplierSummary({ s }: { s: Supplier }) {
  const terms = supplierTerms(s);
  return (
    <>
      <div>
        {SUPPLIER_KIND_LABELS[s.kind] ?? s.kind}
        {s.kind === 'foreign' && s.from_ru ? ` · «${s.from_ru}»` : ''}
      </div>
      {terms && <div className="muted small">Под заказ: {terms}</div>}
      {s.note && <div className="muted small">{s.note}</div>}
    </>
  );
}

function RenameModal({ kind, value, onClose, onDone }: { kind: AnyDictionaryKind; value: DictionaryValue; onClose: () => void; onDone: () => void }) {
  if (kind === 'suppliers') return <SupplierModal value={value as Supplier} onClose={onClose} onDone={onDone} />;
  return <NameModal kind={kind} value={value} onClose={onClose} onDone={onDone} />;
}

/**
 * D-61: a supplier — its kind (Ozon only for the stock; local or foreign — also «под заказ»), «из США» for the shop,
 * the «под заказ» terms (empty — the defaults of its kind) and the place of its tab. Ozon and iHerb keep their kind.
 */
function SupplierModal({ value, onClose, onDone }: { value: Supplier; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(value.name_ru);
  const [note, setNote] = useState(value.note ?? '');
  const [kind, setKind] = useState<SupplierKind>(value.kind);
  const [fromRu, setFromRu] = useState(value.from_ru ?? '');
  const [fromUz, setFromUz] = useState(value.from_uz ?? '');
  const num = (v: number | null) => (v == null ? '' : String(v));
  const [min, setMin] = useState(num(value.days_min));
  const [max, setMax] = useState(num(value.days_max));
  const [guarantee, setGuarantee] = useState(num(value.guarantee_days));
  const [sort, setSort] = useState(String(value.sort ?? 100));
  const fixed = !!value.code; // Ozon, iHerb
  const d = kind === 'ozon' ? null : SUPPLIER_DEFAULT_TERMS[kind];
  const save = useMutation({
    mutationFn: () =>
      api(`/staff/dictionaries/suppliers/${value.id}`, {
        method: 'PATCH',
        body: {
          name_ru: name,
          note: note || null,
          ...(!fixed && { kind }),
          ...(kind === 'foreign' && { from_ru: fromRu || null, from_uz: fromUz || null }),
          ...(kind !== 'ozon' && { days_min: toInt(min) ?? null, days_max: toInt(max) ?? null, guarantee_days: toInt(guarantee) ?? null }),
          sort: toInt(sort) ?? 100,
        },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal title="Изменить поставщика" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Название">
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Тип" hint={fixed ? 'У Ozon и iHerb тип не меняется' : 'Ozon — только на склад; местный и зарубежный — ещё и «под заказ», когда на складе ноль'}>
          <select value={kind} disabled={fixed} onChange={(e) => setKind(e.target.value as SupplierKind)}>
            {(Object.keys(SUPPLIER_KIND_LABELS) as SupplierKind[]).map((k) => (
              <option key={k} value={k}>
                {SUPPLIER_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        {kind === 'foreign' && (
          <div className="form-grid">
            <Field label="Покупателю: «Под заказ …» (RU)" hint="Например: из США">
              <input value={fromRu} maxLength={40} onChange={(e) => setFromRu(e.target.value)} />
            </Field>
            <Field label="(UZ)" hint="Например: AQShdan">
              <input value={fromUz} maxLength={40} onChange={(e) => setFromUz(e.target.value)} />
            </Field>
          </div>
        )}
        {d && (
          <div className="form-grid">
            <Field label="Срок под заказ: от, дней" hint={`Пусто — ${d.days_min}`}>
              <input inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} />
            </Field>
            <Field label="до, дней" hint={`Пусто — ${d.days_max}`}>
              <input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} />
            </Field>
            <Field label="Гарантия, дней" hint={`Нет товара к этому дню — покупатель может отменить. Пусто — ${d.guarantee_days}`}>
              <input inputMode="numeric" value={guarantee} onChange={(e) => setGuarantee(e.target.value)} />
            </Field>
          </div>
        )}
        <Field label="Порядок вкладки" hint="Меньше — левее во вкладках «Товары» и «Бренды»">
          <input inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
        </Field>
        <Field label="Заметка" hint="Контакты, условия — видно только в админке">
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorBox error={save.error} />
        <button className="btn" disabled={save.isPending || !name.trim()}>
          Сохранить
        </button>
      </form>
    </Modal>
  );
}

export function NameModal({ kind, value, onClose, onDone }: { kind: AnyDictionaryKind; value: DictionaryValue; onClose: () => void; onDone: () => void }) {
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

/**
 * D-65 / аудит 4.6: «Объединить» a duplicate into the value that stays. Its products move there, for a brand also
 * campaigns and banners; the duplicate goes to the archive (not deleted). Admin only; written to the audit log.
 */
export function MergeModal({ kind, value, onClose, onDone }: { kind: DictionaryKind; value: DictionaryValue; onClose: () => void; onDone: () => void }) {
  const list = useDictionary(kind);
  const [into, setInto] = useState('');
  const target = list.data?.find((v) => v.id === into);
  const merge = useMutation({
    mutationFn: () => api<{ products_moved: number }>(`/staff/dictionaries/${kind}/${value.id}/merge`, { method: 'POST', body: { into_id: into } }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  const others = (list.data ?? []).filter((v) => v.id !== value.id && v.status === 'active');
  return (
    <Modal title={`Объединить «${value.name_ru}»`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (target && window.confirm(`Перенести ${value.products} товар(ов) из «${value.name_ru}» в «${target.name_ru}»? «${value.name_ru}» уйдёт в архив.`)) merge.mutate();
        }}
      >
        <Field label="Оставить" hint={`Товары «${value.name_ru}» (${value.products}) перейдут сюда${kind === 'brands' ? ', вместе с акциями и баннерами' : ''}; «${value.name_ru}» уйдёт в архив, не удаляется.`}>
          {list.isPending ? (
            <Loading />
          ) : (
            <select value={into} onChange={(e) => setInto(e.target.value)} required aria-label="Оставить">
              <option value="">— выберите —</option>
              {others.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name_ru} ({v.products})
                </option>
              ))}
            </select>
          )}
        </Field>
        <ErrorBox error={merge.error} />
        <button className="btn" disabled={!target || merge.isPending}>
          Объединить
        </button>
      </form>
    </Modal>
  );
}
