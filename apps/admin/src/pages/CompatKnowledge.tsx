import { Help } from '../components/ui';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Badge, ErrorBox, Field, Loading, Modal } from "../components/ui";
import { api } from "../lib/api";
import { dateTime } from "../lib/format";

type SubstanceKind = "substance" | "form" | "drug_group";
type RuleKind = "synergy" | "spread" | "avoid" | "drug_caution";
type RuleStatus = "draft" | "approved" | "off";
type When =
  "morning" | "day" | "evening" | "with_food" | "empty_stomach" | "any";

export interface Substance {
  id: string;
  code: string;
  kind: SubstanceKind;
  name_ru: string;
  name_uz: string;
  synonyms: string[];
  parent: { id: string; name_ru: string } | null;
  enabled: boolean;
  products: number;
  rules: number;
}
interface Rule {
  id: string;
  a: { id: string; name_ru: string; kind: SubstanceKind };
  b: { id: string; name_ru: string; kind: SubstanceKind };
  kind: RuleKind;
  interval_hours: number | null;
  when_a: When | null;
  when_b: When | null;
  text_ru: string;
  text_uz: string;
  source: string | null;
  origin: "xlsx" | "vitalo" | "admin";
  status: RuleStatus;
  approved_by: string | null;
  approved_at: string | null;
}
interface ProductRow {
  id: string;
  sku: string;
  status: string;
  name: string;
  composition: string | null;
  substances: { id: string; name_ru: string }[];
}

const KIND: Record<SubstanceKind, string> = {
  substance: "Вещество",
  form: "Форма вещества",
  drug_group: "Группа лекарств",
};
const RULE_KIND: Record<RuleKind, [string, "ok" | "warn" | "bad"]> = {
  synergy: ["Синергия", "ok"],
  spread: ["Разнести по времени", "warn"],
  avoid: ["Не сочетать", "bad"],
  drug_caution: ["Осторожно с лекарствами", "bad"],
};
const STATUS: Record<RuleStatus, [string, "neutral" | "ok" | "warn"]> = {
  draft: ["Черновик", "warn"],
  approved: ["Одобрено", "ok"],
  off: ["Выключено", "neutral"],
};
const WHEN: Record<When, string> = {
  morning: "Утро",
  day: "День",
  evening: "Вечер",
  with_food: "С едой",
  empty_stomach: "Натощак",
  any: "Не важно",
};
const ORIGIN: Record<Rule["origin"], string> = {
  xlsx: "из таблицы",
  vitalo: "предложение VITALO",
  admin: "добавлено в админке",
};

const useSubstances = () =>
  useQuery({
    queryKey: ["compat", "substances"],
    queryFn: () => api<Substance[]>("/staff/compat/substances"),
  });

// ---------------- rules ----------------

/**
 * «Совместимость → Правила» (3.8, D-45). VITALO AI sees only approved rules; only an admin approves. A specialist's
 * edit of an approved rule sends it back to «Черновик».
 */
export function RulesTab({
  canEdit,
  canApprove,
}: {
  canEdit: boolean;
  canApprove: boolean;
}) {
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ["compat", "rules"],
    queryFn: () => api<Rule[]>("/staff/compat/rules"),
  });
  // аудит 10.11, п. 1.10: пока вкладку не выбрали — «Черновик», если черновики есть, иначе «Одобрено» (не пустой список)
  const [chosen, setFilter] = useState<RuleStatus | "all" | null>(null);
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  const status = useMutation({
    mutationFn: (v: { ids: string[]; status: RuleStatus }) =>
      api<Rule[]>("/staff/compat/rules/status", { method: "POST", body: v }),
    onSuccess: (list) => client.setQueryData(["compat", "rules"], list),
  });
  if (q.isPending) return <Loading />;
  if (q.isError)
    return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const count = (s: RuleStatus) => q.data.filter((r) => r.status === s).length;
  const filter: RuleStatus | "all" = chosen ?? (count("draft") > 0 ? "draft" : "approved");
  const rows =
    filter === "all" ? q.data : q.data.filter((r) => r.status === filter);
  const drafts = q.data.filter((r) => r.status === "draft");
  return (
    <>
      <Help id="compat-knowledge">
        Правила связывают два вещества из справочника. VITALO AI видит{" "}
        <strong>только одобренные</strong> правила; одобряет администратор.
        Правило действует, когда вещества A и B в <strong>разных</strong>{" "}
        товарах корзины.
      </Help>
      <div className="compat-toolbar">
        <div className="segmented">
          {(["draft", "approved", "off", "all"] as const).map((s) => (
            <button
              key={s}
              className={filter === s ? "is-on" : ""}
              onClick={() => setFilter(s)}
            >
              {s === "all"
                ? `Все (${q.data.length})`
                : `${STATUS[s][0]} (${count(s)})`}
            </button>
          ))}
        </div>
        {canEdit && (
          <button className="btn btn-ghost" onClick={() => setEditing("new")}>
            + Правило
          </button>
        )}
        {canApprove && filter === "draft" && drafts.length > 0 && (
          <button
            className="btn"
            disabled={status.isPending}
            onClick={() =>
              window.confirm(
                `Одобрить все черновики (${drafts.length})? После этого VITALO AI начнёт на них опираться.`,
              ) &&
              status.mutate({
                ids: drafts.map((r) => r.id),
                status: "approved",
              })
            }
          >
            Одобрить все черновики
          </button>
        )}
      </div>
      <ErrorBox error={status.error} />
      {!rows.length ? (
        <p className="muted">В этом списке правил нет.</p>
      ) : (
        <div className="card flush table-scroll">
          <table className="table compat-table">
            <thead>
              <tr>
                <th>Вещество A</th>
                <th>Вещество B</th>
                <th>Связь</th>
                <th>Когда принимать</th>
                <th>Объяснение для клиента</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.status === "off" ? "muted" : ""}>
                  <td>{r.a.name_ru}</td>
                  <td>{r.b.name_ru}</td>
                  <td>
                    <Badge tone={RULE_KIND[r.kind][1]}>
                      {RULE_KIND[r.kind][0]}
                    </Badge>
                    {r.interval_hours != null && (
                      <div className="small">интервал {r.interval_hours} ч</div>
                    )}
                  </td>
                  <td className="small nowrap">
                    A: {r.when_a ? WHEN[r.when_a] : "—"}
                    <br />
                    B: {r.when_b ? WHEN[r.when_b] : "—"}
                  </td>
                  <td className="compat-answer-cell small">
                    <div className="pre">RU: {r.text_ru}</div>
                    <div className="pre">UZ: {r.text_uz}</div>
                    <div className="muted">
                      {ORIGIN[r.origin]}
                      {r.source && ` · ${r.source}`}
                    </div>
                  </td>
                  <td className="small">
                    <Badge tone={STATUS[r.status][1]}>
                      {STATUS[r.status][0]}
                    </Badge>
                    {r.status === "approved" && r.approved_by && (
                      <div className="muted">
                        {r.approved_by}
                        {r.approved_at && `, ${dateTime(r.approved_at)}`}
                      </div>
                    )}
                  </td>
                  <td className="ops">
                    {canApprove && r.status !== "approved" && (
                      <button
                        className="btn btn-sm"
                        disabled={status.isPending}
                        onClick={() =>
                          status.mutate({ ids: [r.id], status: "approved" })
                        }
                      >
                        Одобрить
                      </button>
                    )}
                    {canEdit && (
                      <>
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => setEditing(r)}
                        >
                          Изменить
                        </button>
                        {r.status !== "off" ? (
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={status.isPending}
                            onClick={() =>
                              status.mutate({ ids: [r.id], status: "off" })
                            }
                          >
                            Выключить
                          </button>
                        ) : (
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={status.isPending}
                            onClick={() =>
                              status.mutate({ ids: [r.id], status: "draft" })
                            }
                          >
                            В черновик
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <RuleEditor
          rule={editing === "new" ? null : editing}
          canApprove={canApprove}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function RuleEditor({
  rule,
  canApprove,
  onClose,
}: {
  rule: Rule | null;
  canApprove: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const subs = useSubstances();
  const [v, setV] = useState({
    substance_a_id: rule?.a.id ?? "",
    substance_b_id: rule?.b.id ?? "",
    kind: rule?.kind ?? ("synergy" as RuleKind),
    interval_hours: rule?.interval_hours ?? null,
    when_a: rule?.when_a ?? null,
    when_b: rule?.when_b ?? null,
    text_ru: rule?.text_ru ?? "",
    text_uz: rule?.text_uz ?? "",
    source: rule?.source ?? "",
  });
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) =>
    setV({ ...v, [k]: value });
  const m = useMutation({
    mutationFn: () =>
      api<Rule[]>(
        rule ? `/staff/compat/rules/${rule.id}` : "/staff/compat/rules",
        { method: rule ? "PATCH" : "POST", body: v },
      ),
    onSuccess: (list) => {
      client.setQueryData(["compat", "rules"], list);
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  const options = (subs.data ?? []).filter(
    (s) => s.enabled || s.id === v.substance_a_id || s.id === v.substance_b_id,
  );
  const pick = (k: "substance_a_id" | "substance_b_id") => (
    <select value={v[k]} onChange={(e) => set(k, e.target.value)} required>
      <option value="">— выберите —</option>
      {options.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name_ru}
        </option>
      ))}
    </select>
  );
  const when = (k: "when_a" | "when_b") => (
    <select
      value={v[k] ?? ""}
      onChange={(e) => set(k, (e.target.value || null) as When | null)}
    >
      <option value="">—</option>
      {(Object.keys(WHEN) as When[]).map((w) => (
        <option key={w} value={w}>
          {WHEN[w]}
        </option>
      ))}
    </select>
  );
  return (
    <Modal
      title={rule ? "Правило совместимости" : "Новое правило"}
      onClose={onClose}
      wide
    >
      <form onSubmit={submit}>
        {rule?.status === "approved" && !canApprove && (
          <div className="alert alert-warn">
            После изменения правило вернётся в черновики — его снова одобрит
            администратор.
          </div>
        )}
        <div className="grid-2">
          <Field label="Вещество A">{pick("substance_a_id")}</Field>
          <Field label="Вещество B (или группа лекарств)">
            {pick("substance_b_id")}
          </Field>
          <Field label="Связь">
            <select
              value={v.kind}
              onChange={(e) => set("kind", e.target.value as RuleKind)}
            >
              {(Object.keys(RULE_KIND) as RuleKind[]).map((k) => (
                <option key={k} value={k}>
                  {RULE_KIND[k][0]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Интервал, часов" hint="Для «Разнести по времени»">
            <input
              type="number"
              min={1}
              max={24}
              value={v.interval_hours ?? ""}
              onChange={(e) =>
                set(
                  "interval_hours",
                  e.target.value ? Number(e.target.value) : null,
                )
              }
            />
          </Field>
          <Field label="Когда принимать A">{when("when_a")}</Field>
          <Field label="Когда принимать B">{when("when_b")}</Field>
        </div>
        <Field
          label="Объяснение для клиента RU"
          hint="1 предложение, без «лечит», «100%», «гарантирует»"
        >
          <textarea
            rows={3}
            maxLength={600}
            value={v.text_ru}
            onChange={(e) => set("text_ru", e.target.value)}
            required
          />
        </Field>
        <Field label="Объяснение UZ">
          <textarea
            rows={3}
            maxLength={600}
            value={v.text_uz}
            onChange={(e) => set("text_uz", e.target.value)}
            required
          />
        </Field>
        <Field
          label="Источник / комментарий врача"
          hint="Видят только сотрудники"
        >
          <input
            maxLength={300}
            value={v.source ?? ""}
            onChange={(e) => set("source", e.target.value)}
          />
        </Field>
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

// ---------------- substances ----------------

/** «Совместимость → Вещества»: the dictionary with synonyms; a form points at its substance (P-5-P → B6). */
export function SubstancesTab({ canEdit }: { canEdit: boolean }) {
  const q = useSubstances();
  const [editing, setEditing] = useState<Substance | "new" | null>(null);
  if (q.isPending) return <Loading />;
  if (q.isError)
    return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <>
      <Help id="compat-substances">
        Справочник веществ для проверки совместимости. Синонимы — как вещество
        пишут на этикетках и в составе («D3», «холекальциферол»). Форма вещества
        получает его правила: P-5-P — форма B6. Группы лекарств — только для
        правил «Осторожно с лекарствами». Вещества не удаляются, а выключаются.
      </Help>
      {canEdit && (
        <div className="compat-toolbar">
          <button className="btn btn-ghost" onClick={() => setEditing("new")}>
            + Вещество
          </button>
        </div>
      )}
      <div className="card flush table-scroll">
        <table className="table compat-table">
          <thead>
            <tr>
              <th>Название RU / UZ</th>
              <th>Вид</th>
              <th>Синонимы</th>
              <th className="num">Товаров</th>
              <th className="num">Правил</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((s) => (
              <tr key={s.id} className={s.enabled ? "" : "muted"}>
                <td>
                  <strong>{s.name_ru}</strong>
                  <div className="muted small">{s.name_uz}</div>
                </td>
                <td className="small">
                  {KIND[s.kind]}
                  {s.parent && (
                    <div className="muted">форма: {s.parent.name_ru}</div>
                  )}
                </td>
                <td className="small compat-comment">
                  {s.synonyms.join(", ") || "—"}
                </td>
                <td className="num">{s.products}</td>
                <td className="num">{s.rules}</td>
                <td className="ops">
                  {!s.enabled && <Badge>Выключено</Badge>}
                  {canEdit && (
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => setEditing(s)}
                    >
                      Изменить
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <SubstanceEditor
          substance={editing === "new" ? null : editing}
          all={q.data}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function SubstanceEditor({
  substance,
  all,
  onClose,
}: {
  substance: Substance | null;
  all: Substance[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [v, setV] = useState({
    name_ru: substance?.name_ru ?? "",
    name_uz: substance?.name_uz ?? "",
    kind: substance?.kind ?? ("substance" as SubstanceKind),
    parent_id: substance?.parent?.id ?? null,
    synonyms: (substance?.synonyms ?? []).join(", "),
    enabled: substance?.enabled ?? true,
  });
  const m = useMutation({
    mutationFn: () => {
      const body = {
        ...v,
        parent_id: v.kind === "form" ? v.parent_id : null,
        synonyms: v.synonyms
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
      return api<Substance[]>(
        substance
          ? `/staff/compat/substances/${substance.id}`
          : "/staff/compat/substances",
        {
          method: substance ? "PATCH" : "POST",
          body: substance ? body : { ...body, enabled: undefined },
        },
      );
    },
    onSuccess: (list) => {
      client.setQueryData(["compat", "substances"], list);
      void client.invalidateQueries({ queryKey: ["compat", "rules"] });
      onClose();
    },
  });
  return (
    <Modal
      title={substance ? substance.name_ru : "Новое вещество"}
      onClose={onClose}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <div className="grid-2">
          <Field label="Название RU">
            <input
              maxLength={120}
              value={v.name_ru}
              onChange={(e) => setV({ ...v, name_ru: e.target.value })}
              required
            />
          </Field>
          <Field label="Название UZ">
            <input
              maxLength={120}
              value={v.name_uz}
              onChange={(e) => setV({ ...v, name_uz: e.target.value })}
              required
            />
          </Field>
          <Field label="Вид">
            <select
              value={v.kind}
              onChange={(e) =>
                setV({ ...v, kind: e.target.value as SubstanceKind })
              }
            >
              {(Object.keys(KIND) as SubstanceKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND[k]}
                </option>
              ))}
            </select>
          </Field>
          {v.kind === "form" && (
            <Field
              label="Форма какого вещества"
              hint="Правила этого вещества действуют и на форму"
            >
              <select
                value={v.parent_id ?? ""}
                onChange={(e) =>
                  setV({ ...v, parent_id: e.target.value || null })
                }
                required
              >
                <option value="">— выберите —</option>
                {all
                  .filter(
                    (s) => s.id !== substance?.id && s.kind === "substance",
                  )
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name_ru}
                    </option>
                  ))}
              </select>
            </Field>
          )}
        </div>
        <Field
          label="Синонимы — через запятую"
          hint="Как пишут на этикетке: «цитрат магния, бисглицинат магния». Регистр не важен."
        >
          <textarea
            rows={3}
            value={v.synonyms}
            onChange={(e) => setV({ ...v, synonyms: e.target.value })}
          />
        </Field>
        {substance && (
          <label className="check">
            <input
              type="checkbox"
              checked={v.enabled}
              onChange={(e) => setV({ ...v, enabled: e.target.checked })}
            />{" "}
            Включено (выключенное вещество не предлагается для новых правил и
            товаров)
          </label>
        )}
        <ErrorBox error={m.error} />
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

// ---------------- products ----------------

/** «Совместимость → Товары»: substances of each product, chosen from the dictionary. */
export function ProductSubstancesTab({ canEdit }: { canEdit: boolean }) {
  const q = useQuery({
    queryKey: ["compat", "products"],
    queryFn: () => api<ProductRow[]>("/staff/compat/products"),
  });
  const [editing, setEditing] = useState<ProductRow | null>(null);
  if (q.isPending) return <Loading />;
  if (q.isError)
    return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const empty = q.data.filter((p) => !p.substances.length).length;
  return (
    <>
      <Help id="compat-products">
        Вещества товара для проверки совместимости — выбираются из справочника.
        Без веществ товар в проверке не участвует.
        {empty > 0 && <strong> Без веществ: {empty}.</strong>}
      </Help>
      <div className="card flush table-scroll">
        <table className="table compat-table">
          <thead>
            <tr>
              <th>Товар</th>
              <th>Состав (из карточки)</th>
              <th>Вещества</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.name}
                  <div className="muted small">
                    {p.sku}
                    {p.status !== "active" &&
                      ` · ${p.status === "hidden" ? "скрыт" : p.status}`}
                  </div>
                </td>
                <td className="small compat-comment">{p.composition || "—"}</td>
                <td className="small">
                  {p.substances.length ? (
                    p.substances.map((s) => s.name_ru).join(", ")
                  ) : (
                    <Badge tone="warn">нет</Badge>
                  )}
                </td>
                <td className="ops">
                  {canEdit && (
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => setEditing(p)}
                    >
                      Изменить
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <ProductSubstancesEditor
          product={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function ProductSubstancesEditor({
  product,
  onClose,
}: {
  product: ProductRow;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const subs = useSubstances();
  const [chosen, setChosen] = useState(
    new Set(product.substances.map((s) => s.id)),
  );
  const m = useMutation({
    mutationFn: () =>
      api<ProductRow[]>(`/staff/compat/products/${product.id}/substances`, {
        method: "PUT",
        body: { substance_ids: [...chosen] },
      }),
    onSuccess: (list) => {
      client.setQueryData(["compat", "products"], list);
      void client.invalidateQueries({ queryKey: ["compat", "substances"] });
      onClose();
    },
  });
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };
  const list = (subs.data ?? []).filter(
    (s) => s.kind !== "drug_group" && (s.enabled || chosen.has(s.id)),
  );
  return (
    <Modal title={product.name} onClose={onClose} wide>
      <p className="small">
        <strong>Состав:</strong> {product.composition || "—"}
      </p>
      {subs.isPending ? (
        <Loading />
      ) : (
        <div className="compat-substance-grid">
          {list.map((s) => (
            <label key={s.id} className="check">
              <input
                type="checkbox"
                checked={chosen.has(s.id)}
                onChange={() => toggle(s.id)}
              />{" "}
              {s.name_ru}
              {s.parent && (
                <span className="muted small"> (форма {s.parent.name_ru})</span>
              )}
            </label>
          ))}
        </div>
      )}
      <ErrorBox error={m.error ?? subs.error} />
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button
          className="btn"
          disabled={m.isPending}
          onClick={() => m.mutate()}
        >
          Сохранить
        </button>
      </div>
    </Modal>
  );
}
