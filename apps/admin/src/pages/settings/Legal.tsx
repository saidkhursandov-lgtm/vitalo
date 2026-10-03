import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';

interface LegalDoc {
  id: string;
  code: 'offer' | 'privacy';
  version: string;
  status: 'draft' | 'active' | 'archived';
  published_at: string | null;
  text_ru: string;
  text_uz: string;
  acceptances: number;
  placeholders: string[];
}

const TITLES = { offer: 'Публичная оферта', privacy: 'Политика конфиденциальности' } as const;
const STATUS = { draft: ['Черновик', 'warn'], active: ['Действует', 'ok'], archived: ['В архиве', 'neutral'] } as const;

/**
 * Public offer and Privacy policy: a draft is edited and then published; publishing a new version
 * makes every customer see the consent screen again. Published texts are never edited.
 */
export function LegalSettings() {
  const q = useQuery({ queryKey: ['settings', 'legal'], queryFn: () => api<LegalDoc[]>('/staff/legal') });
  const [edit, setEdit] = useState<LegalDoc | { code: LegalDoc['code']; from?: LegalDoc } | null>(null);
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} />;
  return (
    <>
      {(Object.keys(TITLES) as LegalDoc['code'][]).map((code) => {
        const docs = q.data.filter((d) => d.code === code);
        const active = docs.find((d) => d.status === 'active');
        return (
          <section key={code} className="card">
            <div className="section-head">
              <h2>{TITLES[code]}</h2>
              <button className="btn btn-ghost" onClick={() => setEdit({ code, from: active ?? docs[0] })}>
                + Новая версия
              </button>
            </div>
            {!active && <div className="alert alert-warn">Нет действующей версии — покупатели не увидят экран согласия.</div>}
            <table className="table">
              <thead>
                <tr>
                  <th>Версия</th>
                  <th>Статус</th>
                  <th>Опубликована</th>
                  <th className="num">Согласий</th>
                  <th>Поля [ ]</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td className="strong">{d.version}</td>
                    <td>
                      <Badge tone={STATUS[d.status][1]}>{STATUS[d.status][0]}</Badge>
                    </td>
                    <td>{d.published_at ? dateTime(d.published_at) : '—'}</td>
                    <td className="num">{d.acceptances}</td>
                    <td>{d.placeholders.length ? <Badge tone="warn">{d.placeholders.length}</Badge> : <span className="muted">нет</span>}</td>
                    <td>
                      <button className="btn btn-sm btn-ghost" onClick={() => setEdit(d)}>
                        {d.status === 'draft' ? 'Изменить' : 'Открыть'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
      {edit && <LegalModal doc={'id' in edit ? edit : null} code={edit.code} from={'from' in edit ? edit.from : undefined} onClose={() => setEdit(null)} />}
    </>
  );
}

function LegalModal({ doc, code, from, onClose }: { doc: LegalDoc | null; code: LegalDoc['code']; from?: LegalDoc; onClose: () => void }) {
  const client = useQueryClient();
  const readOnly = !!doc && doc.status !== 'draft';
  const [f, setF] = useState({ version: doc?.version ?? '', text_ru: doc?.text_ru ?? from?.text_ru ?? '', text_uz: doc?.text_uz ?? from?.text_uz ?? '' });
  const [warnPublish, setWarnPublish] = useState<string[] | null>(null);
  const done = (list: LegalDoc[]) => {
    client.setQueryData(['settings', 'legal'], list);
    onClose();
  };
  const save = useMutation({
    mutationFn: () => (doc ? api<LegalDoc[]>(`/staff/legal/${doc.id}`, { method: 'PATCH', body: f }) : api<LegalDoc[]>('/staff/legal', { method: 'POST', body: { code, ...f } })),
    onSuccess: done,
  });
  const publish = useMutation({
    mutationFn: async () => {
      // Save the latest edits first, then publish this draft.
      const list = await (doc ? api<LegalDoc[]>(`/staff/legal/${doc.id}`, { method: 'PATCH', body: f }) : api<LegalDoc[]>('/staff/legal', { method: 'POST', body: { code, ...f } }));
      const id = doc?.id ?? list.find((d) => d.code === code && d.version === f.version)!.id;
      return api<LegalDoc[]>(`/staff/legal/${id}/publish`, { method: 'POST' });
    },
    onSuccess: done,
  });
  const placeholders = [...new Set(`${f.text_ru}\n${f.text_uz}`.match(/\\?\[[^\]\n]{0,120}?\\?\]/g) ?? [])].map((p) => p.replace(/\\/g, '')).filter((p) => !`${f.text_ru}${f.text_uz}`.includes(`${p}(`));
  const tryPublish = () => (placeholders.length ? setWarnPublish(placeholders) : publish.mutate());

  return (
    <Modal title={`${TITLES[code]}${doc ? ` — версия ${doc.version}` : ' — новая версия'}`} onClose={onClose} wide>
      {readOnly && <div className="alert alert-info">Опубликованный текст не меняется: на него уже согласились покупатели. Для правок создайте новую версию.</div>}
      <Field label="Номер версии" hint="Например 1.0. Новая опубликованная версия снова покажет покупателям экран согласия.">
        <input value={f.version} disabled={readOnly} maxLength={20} onChange={(e) => setF({ ...f, version: e.target.value })} required />
      </Field>
      <Field label="Текст (RU)" hint="Markdown: **жирный**, списки через «- », пустая строка — новый абзац">
        <textarea rows={12} value={f.text_ru} readOnly={readOnly} onChange={(e) => setF({ ...f, text_ru: e.target.value })} />
      </Field>
      <Field label="Текст (UZ)">
        <textarea rows={12} value={f.text_uz} readOnly={readOnly} onChange={(e) => setF({ ...f, text_uz: e.target.value })} />
      </Field>
      {placeholders.length > 0 && !readOnly && <div className="alert alert-warn">Остались незаполненные поля в квадратных скобках: {placeholders.slice(0, 8).join(', ')}{placeholders.length > 8 ? '…' : ''}</div>}
      {warnPublish && (
        <div className="alert alert-error" role="alert">
          <span>
            В тексте остались поля в квадратных скобках ({warnPublish.length}). Покупатели увидят их как есть. Всё равно опубликовать?
          </span>
          <button className="btn btn-sm btn-danger" disabled={publish.isPending} onClick={() => publish.mutate()}>
            Опубликовать
          </button>
        </div>
      )}
      <ErrorBox error={save.error ?? publish.error} />
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Закрыть
        </button>
        {!readOnly && (
          <>
            <button className="btn btn-ghost" disabled={save.isPending || !f.version} onClick={() => save.mutate()}>
              Сохранить черновик
            </button>
            <button className="btn" disabled={publish.isPending || !f.version || !f.text_ru.trim() || !f.text_uz.trim()} onClick={tryPublish}>
              Опубликовать
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
