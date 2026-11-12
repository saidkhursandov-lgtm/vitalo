import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Badge, ErrorBox, Field, Help, Loading, Modal } from "../components/ui";
import { api } from "../lib/api";
import { dateTime } from "../lib/format";
import type { Substance } from "./CompatKnowledge";

export type Goal = "sleep" | "stress" | "energy" | "joints" | "immunity" | "sport";
type Level = "A" | "B" | "C";
type Status = "draft" | "approved" | "off";

export interface GoalRow {
  id: string;
  substance: { id: string; name_ru: string };
  goal: Goal;
  level: Level;
  helps_ru: string;
  helps_uz: string;
  not_helps_ru: string;
  not_helps_uz: string;
  source: string | null;
  status: Status;
  approved_by: string | null;
  approved_at: string | null;
  updated_at: string;
}

export const GOAL: Record<Goal, string> = {
  sleep: "Сон",
  stress: "Стресс",
  energy: "Энергия",
  joints: "Суставы",
  immunity: "Иммунитет",
  sport: "Спорт",
};
/** D-67: the letter is for the staff; the customer sees the words. */
export const LEVEL: Record<Level, [string, "ok" | "info" | "neutral"]> = {
  A: ["A — Подтверждено исследованиями", "ok"],
  B: ["B — Есть данные исследований", "info"],
  C: ["C — Мнение специалистов", "neutral"],
};
const STATUS: Record<Status, [string, "warn" | "ok" | "neutral"]> = {
  draft: ["Черновик", "warn"],
  approved: ["Одобрено", "ok"],
  off: ["Выключено", "neutral"],
};

/**
 * Шаг 0б (D-69): «База знаний AI → Цели» — «вещество → цель → уровень → когда помогает / когда нет». Fills and approves
 * the doctor; VITALO AI uses only approved rows in «Поможет ли этот набор для моей цели?». A product with no row is
 * «данных немного» for the customer.
 */
export function GoalsTab({ canEdit, canApprove }: { canEdit: boolean; canApprove: boolean }) {
  const client = useQueryClient();
  const q = useQuery({ queryKey: ["compat", "goals"], queryFn: () => api<GoalRow[]>("/staff/compat/goals") });
  const [editing, setEditing] = useState<GoalRow | "new" | null>(null);
  const [goal, setGoal] = useState<Goal | "all">("all");
  const status = useMutation({
    mutationFn: (v: { id: string; status: Status }) =>
      api<GoalRow[]>(`/staff/compat/goals/${v.id}/status`, { method: "POST", body: { status: v.status } }),
    onSuccess: (list) => client.setQueryData(["compat", "goals"], list),
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const rows = goal === "all" ? q.data : q.data.filter((r) => r.goal === goal);
  return (
    <>
      <Help id="compat-goals">
        Для вопроса покупателя «Поможет ли этот набор для моей цели?». VITALO AI
        видит <strong>только одобренные</strong> строки; одобряет администратор.
        Если у товара нет строки для цели, покупатель увидит «данных немного».
        Покупатель видит уровень словами, без букв.
      </Help>
      <div className="compat-toolbar">
        <div className="segmented">
          {(["all", ...Object.keys(GOAL)] as (Goal | "all")[]).map((g) => (
            <button key={g} className={goal === g ? "is-on" : ""} onClick={() => setGoal(g)}>
              {g === "all" ? `Все (${q.data.length})` : `${GOAL[g]} (${q.data.filter((r) => r.goal === g).length})`}
            </button>
          ))}
        </div>
        {canEdit && (
          <button className="btn btn-ghost" onClick={() => setEditing("new")}>
            + Строка
          </button>
        )}
      </div>
      <ErrorBox error={status.error} />
      {!rows.length ? (
        <p className="muted">Строк пока нет. Их заполняет и одобряет врач.</p>
      ) : (
        <div className="card flush table-scroll">
          <table className="table compat-table">
            <thead>
              <tr>
                <th>Вещество</th>
                <th>Цель</th>
                <th>Уровень</th>
                <th>Когда помогает / когда нет</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.status === "off" ? "muted" : ""}>
                  <td>{r.substance.name_ru}</td>
                  <td>{GOAL[r.goal]}</td>
                  <td>
                    <Badge tone={LEVEL[r.level][1]}>{LEVEL[r.level][0]}</Badge>
                  </td>
                  <td className="small">
                    <div>
                      <strong>Помогает:</strong> {r.helps_ru}
                    </div>
                    <div>
                      <strong>Не поможет:</strong> {r.not_helps_ru}
                    </div>
                    {r.source && <div className="muted">Источник: {r.source}</div>}
                  </td>
                  <td>
                    <Badge tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge>
                    {r.approved_by && (
                      <div className="muted small">
                        {r.approved_by}, {r.approved_at ? dateTime(r.approved_at) : ""}
                      </div>
                    )}
                  </td>
                  <td className="ops">
                    {canEdit && (
                      <button className="btn btn-sm btn-ghost" onClick={() => setEditing(r)}>
                        Изменить
                      </button>
                    )}
                    {canApprove && r.status !== "approved" && (
                      <button className="btn btn-sm" disabled={status.isPending} onClick={() => status.mutate({ id: r.id, status: "approved" })}>
                        Одобрить
                      </button>
                    )}
                    {canEdit && r.status !== "off" && (
                      <button className="btn btn-sm btn-ghost" disabled={status.isPending} onClick={() => status.mutate({ id: r.id, status: "off" })}>
                        Выключить
                      </button>
                    )}
                    {canEdit && r.status === "off" && (
                      <button className="btn btn-sm btn-ghost" disabled={status.isPending} onClick={() => status.mutate({ id: r.id, status: "draft" })}>
                        В черновик
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <GoalEditor row={editing === "new" ? null : editing} canApprove={canApprove} onClose={() => setEditing(null)} />}
    </>
  );
}

function GoalEditor({ row, canApprove, onClose }: { row: GoalRow | null; canApprove: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const subs = useQuery({ queryKey: ["compat", "substances"], queryFn: () => api<Substance[]>("/staff/compat/substances") });
  const [v, setV] = useState({
    substance_id: row?.substance.id ?? "",
    goal: row?.goal ?? ("sleep" as Goal),
    level: row?.level ?? ("C" as Level),
    helps_ru: row?.helps_ru ?? "",
    helps_uz: row?.helps_uz ?? "",
    not_helps_ru: row?.not_helps_ru ?? "",
    not_helps_uz: row?.not_helps_uz ?? "",
    source: row?.source ?? "",
  });
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) => setV({ ...v, [k]: value });
  const m = useMutation({
    mutationFn: () => api<GoalRow[]>(row ? `/staff/compat/goals/${row.id}` : "/staff/compat/goals", { method: row ? "PATCH" : "POST", body: v }),
    onSuccess: (list) => {
      client.setQueryData(["compat", "goals"], list);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  const options = (subs.data ?? []).filter((s) => s.kind !== "drug_group" && (s.enabled || s.id === v.substance_id));
  const area = (k: "helps_ru" | "helps_uz" | "not_helps_ru" | "not_helps_uz", label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <textarea rows={2} maxLength={400} value={v[k]} onChange={(e) => set(k, e.target.value)} required />
    </Field>
  );
  return (
    <Modal title={row ? "Вещество и цель" : "Новая строка: вещество и цель"} onClose={onClose} wide>
      <form onSubmit={submit}>
        {row?.status === "approved" && !canApprove && (
          <div className="alert alert-warn">После изменения строка вернётся в черновики — её снова одобрит администратор.</div>
        )}
        <div className="grid-2">
          <Field label="Вещество">
            <select value={v.substance_id} onChange={(e) => set("substance_id", e.target.value)} required>
              <option value="">— выберите —</option>
              {options.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name_ru}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Цель">
            <select value={v.goal} onChange={(e) => set("goal", e.target.value as Goal)}>
              {(Object.keys(GOAL) as Goal[]).map((g) => (
                <option key={g} value={g}>
                  {GOAL[g]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Уровень доказательности" hint="A — систематические обзоры и РКИ, B — отдельные исследования, C — мнение специалистов">
            <select value={v.level} onChange={(e) => set("level", e.target.value as Level)}>
              {(Object.keys(LEVEL) as Level[]).map((l) => (
                <option key={l} value={l}>
                  {LEVEL[l][0]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Источник / комментарий врача" hint="Видят только сотрудники">
            <input maxLength={300} value={v.source} onChange={(e) => set("source", e.target.value)} />
          </Field>
        </div>
        {area("helps_ru", "Когда помогает (RU)", "Простыми словами, без диагнозов и дозировок")}
        {area("helps_uz", "Когда помогает (UZ)")}
        {area("not_helps_ru", "Когда не поможет (RU)")}
        {area("not_helps_uz", "Когда не поможет (UZ)")}
        <ErrorBox error={m.error ?? subs.error} />
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn" disabled={m.isPending}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}
