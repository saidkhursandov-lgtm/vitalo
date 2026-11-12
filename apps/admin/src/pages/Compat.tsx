import { Help } from '../components/ui';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Badge,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHead,
} from "../components/ui";
import { api } from "../lib/api";
import { useSession } from "../lib/auth";
import { dateTime } from "../lib/format";
import {
  ProductSubstancesTab,
  RulesTab,
  SubstancesTab,
} from "./CompatKnowledge";
import { AiAnswersTab } from "./CompatAi";

type Verdict = "compatible" | "spread" | "consult";
type Lang = "ru" | "uz";
type Templates = Record<Verdict, Record<Lang, string>>;

interface Product {
  product_id: string;
  sku: string;
  name: string;
}
export interface CompatRequestRow {
  id: string;
  created_at: string;
  status: "pending" | "answered";
  source: "specialist" | "instant";
  lang: Lang;
  customer: string;
  products: Product[];
  has_comment: boolean;
  comment: string | null;
  comment_hidden: boolean;
  comment_purged: boolean;
  verdict: Verdict | null;
  answer_text: string | null;
  answered_by: string | null;
  answered_at: string | null;
  saved: boolean;
}
interface SavedAnswer {
  id: string;
  lang: Lang;
  verdict: Verdict;
  text: string;
  enabled: boolean;
  products: Product[];
  author: string | null;
  used: number;
  updated_at: string;
}

export const VERDICT: Record<Verdict, [string, "ok" | "warn" | "bad"]> = {
  compatible: ["Совместимы", "ok"],
  spread: ["Разнести по времени", "warn"],
  consult: ["Нужна консультация", "bad"],
};
const VERDICTS = Object.keys(VERDICT) as Verdict[];
const LANG: Record<Lang, string> = { ru: "RU", uz: "UZ" };

type Tab =
  | "pending"
  | "answered"
  | "ai"
  | "saved"
  | "templates"
  | "rules"
  | "substances"
  | "products";
const TABS: [Tab, string][] = [
  ["pending", "Новые"],
  ["answered", "Отвеченные"],
  ["ai", "AI-ответы"],
  ["saved", "Сохранённые сочетания"],
  ["templates", "Шаблоны"],
  ["rules", "Правила"],
  ["substances", "Вещества"],
  ["products", "Товары и вещества"],
];
/** Tabs of «База знаний AI» (menu → Каталог); the rest are questions from customers (menu → Продажи). */
export const KNOWLEDGE_TABS: Tab[] = ["rules", "substances", "products"];

/**
 * Админка → Совместимость (3.4, D-40). Requests from the cart (2+ products); admins and employees marked «специалист»
 * answer, edit saved combinations and templates; a manager only looks and never sees the customer's comment.
 */
export function Compat() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  // Генплан, этап 2: one page, two menu items — questions from customers (Продажи) and the AI knowledge (Каталог)
  const tab = (TABS.find(([t]) => t === params.get("tab"))?.[0] ?? "pending") as Tab;
  const setTab = (t: Tab) => setParams(t === "pending" ? {} : { tab: t }, { replace: true });
  const knowledge = KNOWLEDGE_TABS.includes(tab);
  const answer = can("compat.answer");
  return (
    <>
      <PageHead title={knowledge ? "База знаний VITALO AI" : "Вопросы о совместимости"}>
        <div className="segmented">
          {TABS.filter(([t]) => KNOWLEDGE_TABS.includes(t) === knowledge).map(([t, label]) => (
            <button
              key={t}
              className={tab === t ? "is-on" : ""}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          ))}
        </div>
      </PageHead>
      {tab === "ai" ? (
        <AiAnswersTab canEdit={answer} />
      ) : tab === "rules" ? (
        <RulesTab canEdit={answer} canApprove={can("compat.rules.approve")} />
      ) : tab === "substances" ? (
        <SubstancesTab canEdit={answer} />
      ) : tab === "products" ? (
        <ProductSubstancesTab canEdit={answer} />
      ) : (
        <>
          <Help id="compat">
            Покупатель отправляет корзину (2+ разных товара) с необязательным
            комментарием. Ответ приходит ему в бот, в уведомления и в корзину.
            Комментарий может содержать сведения о здоровье: его видят только
            администратор и специалист, через 90 дней текст удаляется (запрос и
            ответ остаются).
            {!answer &&
              " Отвечать может администратор или сотрудник с отметкой «специалист»."}
          </Help>
          {tab === "pending" || tab === "answered" ? (
            <Requests status={tab} canAnswer={answer} />
          ) : tab === "saved" ? (
            <Saved canEdit={answer} />
          ) : (
            <TemplatesCard canEdit={answer} />
          )}
        </>
      )}
    </>
  );
}

function ProductsCell({ products }: { products: Product[] }) {
  return (
    <ul className="compat-products">
      {products.map((p) => (
        <li key={p.product_id}>
          {p.name} <span className="muted small">{p.sku}</span>
        </li>
      ))}
    </ul>
  );
}

function CommentCell({ r }: { r: CompatRequestRow }) {
  if (r.comment_purged)
    return <span className="muted small">удалён через 90 дней</span>;
  if (r.comment_hidden)
    return <span className="muted small">есть, скрыт (видит специалист)</span>;
  return r.comment ? (
    <span className="pre small">{r.comment}</span>
  ) : (
    <span className="muted">—</span>
  );
}

function Requests({
  status,
  canAnswer,
}: {
  status: "pending" | "answered";
  canAnswer: boolean;
}) {
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ["compat", status],
    queryFn: () =>
      api<CompatRequestRow[]>(`/staff/compat/requests?status=${status}`),
  });
  const [answering, setAnswering] = useState<CompatRequestRow | null>(null);
  const save = useMutation({
    mutationFn: (id: string) =>
      api(`/staff/compat/requests/${id}/save`, { method: "POST" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["compat"] }),
  });
  if (q.isPending) return <Loading />;
  if (q.isError)
    return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data.length)
    return (
      <p className="muted">
        {status === "pending"
          ? "Новых запросов нет."
          : "Отвеченных запросов пока нет."}
      </p>
    );
  return (
    <div className="card flush table-scroll">
      <ErrorBox error={save.error} />
      <table className="table compat-table">
        <thead>
          <tr>
            <th>Когда</th>
            <th>Клиент</th>
            <th>Состав корзины</th>
            <th>Комментарий</th>
            {status === "answered" && <th>Ответ</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {q.data.map((r) => (
            <tr key={r.id}>
              <td className="nowrap small">
                {dateTime(r.created_at)}
                <div>
                  <Badge tone="info">{LANG[r.lang]}</Badge>
                </div>
              </td>
              <td className="small">{r.customer}</td>
              <td>
                <ProductsCell products={r.products} />
              </td>
              <td className="compat-comment">
                <CommentCell r={r} />
              </td>
              {status === "answered" && (
                <td className="compat-answer-cell">
                  {r.verdict && (
                    <Badge tone={VERDICT[r.verdict][1]}>
                      {VERDICT[r.verdict][0]}
                    </Badge>
                  )}
                  <div className="pre small">{r.answer_text}</div>
                  <div className="muted small">
                    {r.source === "instant"
                      ? "сохранённый ответ"
                      : (r.answered_by ?? "—")}
                    {r.answered_at && `, ${dateTime(r.answered_at)}`}
                  </div>
                </td>
              )}
              <td className="ops">
                {status === "pending" && canAnswer && (
                  <button
                    className="btn btn-sm"
                    onClick={() => setAnswering(r)}
                  >
                    Ответить
                  </button>
                )}
                {status === "answered" &&
                  (r.saved ? (
                    <Badge tone="ok">Сохранён</Badge>
                  ) : (
                    canAnswer &&
                    r.source === "specialist" && (
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={save.isPending}
                        onClick={() => save.mutate(r.id)}
                      >
                        Использовать повторно
                      </button>
                    )
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {answering && (
        <AnswerModal request={answering} onClose={() => setAnswering(null)} />
      )}
    </div>
  );
}

function AnswerModal({
  request,
  onClose,
}: {
  request: CompatRequestRow;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const templates = useQuery({
    queryKey: ["compat", "templates"],
    queryFn: () => api<Templates>("/staff/compat/templates"),
  });
  const [verdict, setVerdict] = useState<Verdict>("compatible");
  const [text, setText] = useState<string | null>(null);
  const [reuse, setReuse] = useState(false);
  const shown = text ?? templates.data?.[verdict][request.lang] ?? "";
  const m = useMutation({
    mutationFn: () =>
      api<{ result: string; by?: string }>(
        `/staff/compat/requests/${request.id}/answer`,
        { method: "POST", body: { verdict, text: shown, reuse } },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["compat"] });
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <Modal title="Ответ на запрос совместимости" onClose={onClose} wide>
      <form onSubmit={submit}>
        <ProductsCell products={request.products} />
        <p className="small">
          <strong>Комментарий клиента:</strong> <CommentCell r={request} />
        </p>
        <Field label="Метка">
          <div className="segmented">
            {VERDICTS.map((v) => (
              <button
                type="button"
                key={v}
                className={verdict === v ? "is-on" : ""}
                onClick={() => {
                  setVerdict(v);
                  setText(null); // the template of the new label
                }}
              >
                {VERDICT[v][0]}
              </button>
            ))}
          </div>
        </Field>
        <Field
          label={`Текст ответа — на языке клиента (${LANG[request.lang]})`}
          hint="Подставлен шаблон метки; можно изменить. Клиент увидит текст как есть."
        >
          <textarea
            rows={5}
            maxLength={1000}
            value={shown}
            onChange={(e) => setText(e.target.value)}
            required
          />
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={reuse}
            onChange={(e) => setReuse(e.target.checked)}
          />{" "}
          Можно использовать повторно — сразу показывать этот ответ другим
          покупателям с тем же набором товаров на {LANG[request.lang]} (если они
          не написали комментарий)
        </label>
        <ErrorBox error={m.error} />
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn" disabled={m.isPending || !shown.trim()}>
            Отправить клиенту
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Saved({ canEdit }: { canEdit: boolean }) {
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ["compat", "answers"],
    queryFn: () => api<SavedAnswer[]>("/staff/compat/answers"),
  });
  const [editing, setEditing] = useState<SavedAnswer | null>(null);
  const toggle = useMutation({
    mutationFn: (a: SavedAnswer) =>
      api<SavedAnswer[]>(`/staff/compat/answers/${a.id}`, {
        method: "PATCH",
        body: { enabled: !a.enabled },
      }),
    onSuccess: (list) => client.setQueryData(["compat", "answers"], list),
  });
  if (q.isPending) return <Loading />;
  if (q.isError)
    return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data.length)
    return (
      <p className="muted">
        Сохранённых сочетаний пока нет. Отметьте «Можно использовать повторно»
        при ответе.
      </p>
    );
  return (
    <div className="card flush table-scroll">
      <ErrorBox error={toggle.error} />
      <table className="table compat-table">
        <thead>
          <tr>
            <th>Набор товаров</th>
            <th>Язык</th>
            <th>Ответ</th>
            <th className="num">Выдан сразу</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {q.data.map((a) => (
            <tr key={a.id} className={a.enabled ? "" : "muted"}>
              <td>
                <ProductsCell products={a.products} />
              </td>
              <td>
                <Badge tone="info">{LANG[a.lang]}</Badge>
              </td>
              <td className="compat-answer-cell">
                <Badge tone={VERDICT[a.verdict][1]}>
                  {VERDICT[a.verdict][0]}
                </Badge>
                <div className="pre small">{a.text}</div>
                <div className="muted small">
                  {a.author ?? "—"}, {dateTime(a.updated_at)}
                </div>
              </td>
              <td className="num">{a.used}</td>
              <td className="ops">
                {a.enabled ? (
                  <Badge tone="ok">Включён</Badge>
                ) : (
                  <Badge>Выключен</Badge>
                )}
                {canEdit && (
                  <>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => setEditing(a)}
                    >
                      Изменить
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate(a)}
                    >
                      {a.enabled ? "Выключить" : "Включить"}
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <SavedEditor answer={editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function SavedEditor({
  answer,
  onClose,
}: {
  answer: SavedAnswer;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [verdict, setVerdict] = useState(answer.verdict);
  const [text, setText] = useState(answer.text);
  const m = useMutation({
    mutationFn: () =>
      api<SavedAnswer[]>(`/staff/compat/answers/${answer.id}`, {
        method: "PATCH",
        body: { verdict, text },
      }),
    onSuccess: (list) => {
      client.setQueryData(["compat", "answers"], list);
      onClose();
    },
  });
  return (
    <Modal title="Сохранённое сочетание" onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <ProductsCell products={answer.products} />
        <Field label="Метка">
          <select
            value={verdict}
            onChange={(e) => setVerdict(e.target.value as Verdict)}
          >
            {VERDICTS.map((v) => (
              <option key={v} value={v}>
                {VERDICT[v][0]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Текст (${LANG[answer.lang]})`}>
          <textarea
            rows={5}
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
          />
        </Field>
        <ErrorBox error={m.error} />
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="btn" disabled={m.isPending || !text.trim()}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TemplatesCard({ canEdit }: { canEdit: boolean }) {
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ["compat", "templates"],
    queryFn: () => api<Templates>("/staff/compat/templates"),
  });
  const [draft, setDraft] = useState<Templates | null>(null);
  const [saved, setSaved] = useState(false);
  const m = useMutation({
    mutationFn: (templates: Templates) =>
      api<Templates>("/staff/compat/templates", {
        method: "PUT",
        body: { templates },
      }),
    onSuccess: (t) => {
      client.setQueryData(["compat", "templates"], t);
      setDraft(null);
      setSaved(true);
    },
  });
  if (q.isPending) return <Loading />;
  if (q.isError)
    return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const value = draft ?? q.data;
  const set = (v: Verdict, l: Lang, text: string) => {
    setSaved(false);
    setDraft({ ...value, [v]: { ...value[v], [l]: text } });
  };
  return (
    <section className="card">
      <p className="muted small">
        Быстрые ответы: кнопки в боте и подстановка в окне ответа. Клиенту
        уходит текст на его языке.
      </p>
      {VERDICTS.map((v) => (
        <div key={v} className="compat-template">
          <h3>
            <Badge tone={VERDICT[v][1]}>{VERDICT[v][0]}</Badge>
          </h3>
          <div className="grid-2">
            {(["ru", "uz"] as Lang[]).map((l) => (
              <Field key={l} label={LANG[l]}>
                <textarea
                  rows={4}
                  maxLength={1000}
                  value={value[v][l]}
                  disabled={!canEdit}
                  onChange={(e) => set(v, l, e.target.value)}
                />
              </Field>
            ))}
          </div>
        </div>
      ))}
      <ErrorBox error={m.error} />
      {saved && <div className="alert alert-ok">Шаблоны сохранены</div>}
      {canEdit && (
        <div className="modal-actions">
          <button
            className="btn"
            disabled={!draft || m.isPending}
            onClick={() => draft && m.mutate(draft)}
          >
            Сохранить шаблоны
          </button>
        </div>
      )}
    </section>
  );
}
