import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Badge, ErrorBox, Field, Loading, Modal } from "../components/ui";
import { api } from "../lib/api";
import { dateTime } from "../lib/format";

type Verdict = "compatible" | "spread" | "consult";
type Review = "new" | "approved" | "fixed" | "hidden";

export interface AiAnswerRow {
  id: string;
  created_at: string;
  lang: "ru" | "uz";
  verdict: Verdict;
  text: string;
  products: { product_id: string; sku: string; name: string }[];
  timing: { name: string; when: string }[];
  suggestions: number;
  model: string;
  cost_usd: number;
  used: number;
  review: Review;
  reviewed_by: string | null;
  reviewed_at: string | null;
  urgent: boolean;
}

const VERDICT: Record<Verdict, [string, "ok" | "warn" | "bad"]> = {
  compatible: ["Совместимы", "ok"],
  spread: ["Разнести по времени", "warn"],
  consult: ["Нужна консультация", "bad"],
};
const VERDICTS = Object.keys(VERDICT) as Verdict[];
const REVIEW: Record<Review, [string, "neutral" | "ok" | "info" | "bad"]> = {
  new: ["Ждёт проверки", "neutral"],
  approved: ["Одобрен и сохранён", "ok"],
  fixed: ["Исправлен специалистом", "info"],
  hidden: ["Скрыт", "bad"],
};
export const usd = (v: number) =>
  `$${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;

/**
 * 3.8: «Совместимость → AI-ответы» (spec 1.8). Every new VITALO AI answer of the cart waits here; red ones on top with
 * «Проверить в первую очередь». «Одобрить и сохранить» — it becomes a saved specialist answer (3.4) for the set,
 * «Исправить» — the specialist's own text and label, «Скрыть» — out of the cache, the next customer gets a new answer.
 */
export function AiAnswersTab({ canEdit }: { canEdit: boolean }) {
  const client = useQueryClient();
  const [filter, setFilter] = useState<"new" | "all">("new");
  const [fixing, setFixing] = useState<AiAnswerRow | null>(null);
  const q = useQuery({
    queryKey: ["compat", "ai", filter],
    queryFn: () => api<AiAnswerRow[]>(`/staff/ai/answers?filter=${filter}`),
  });
  const review = useMutation({
    mutationFn: (v: { id: string; action: "approve" | "hide" }) =>
      api(`/staff/ai/answers/${v.id}/review`, {
        method: "POST",
        body: { action: v.action },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["compat"] }),
  });
  return (
    <>
      <p className="muted">
        Ответы VITALO AI покупателям показываются сразу и ждут здесь проверки.
        «Одобрить и сохранить» — ответ становится сохранённым ответом
        специалиста для этого набора. «Исправить» — свой текст и метка.
        «Скрыть» — ответ больше не используется, следующий покупатель получит
        новый.
      </p>
      <div className="segmented" style={{ marginBottom: 12 }}>
        <button
          className={filter === "new" ? "is-on" : ""}
          onClick={() => setFilter("new")}
        >
          Ждут проверки
        </button>
        <button
          className={filter === "all" ? "is-on" : ""}
          onClick={() => setFilter("all")}
        >
          Все
        </button>
      </div>
      <ErrorBox error={review.error} />
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data.length ? (
        <p className="muted">
          {filter === "new"
            ? "Все AI-ответы проверены."
            : "AI-ответов пока нет."}
        </p>
      ) : (
        <div className="card flush table-scroll">
          <table className="table compat-table ai-answers-table">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Состав корзины</th>
                <th>Ответ</th>
                <th>Когда принимать</th>
                <th>Показан</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((a) => (
                <tr key={a.id} className={a.urgent ? "row-urgent" : ""}>
                  <td className="nowrap small">
                    {dateTime(a.created_at)}
                    <div>
                      <Badge tone="info">{a.lang.toUpperCase()}</Badge>
                    </div>
                  </td>
                  <td>
                    <ul className="compat-products">
                      {a.products.map((p) => (
                        <li key={p.product_id}>
                          {p.name} <span className="muted small">{p.sku}</span>
                        </li>
                      ))}
                    </ul>
                    {a.suggestions > 0 && (
                      <div className="muted small">
                        предложено товаров: {a.suggestions}
                      </div>
                    )}
                  </td>
                  <td className="compat-answer-cell">
                    {a.urgent && (
                      <div className="urgent-line">
                        <Badge tone="bad" dot>
                          Проверить в первую очередь
                        </Badge>
                      </div>
                    )}
                    <Badge tone={VERDICT[a.verdict][1]}>
                      {VERDICT[a.verdict][0]}
                    </Badge>
                    <div className="pre small">{a.text}</div>
                    <div className="muted small">
                      {a.model} · {usd(a.cost_usd)}
                    </div>
                  </td>
                  <td className="small">
                    {a.timing.map((x, i) => (
                      <div key={i}>
                        {x.name}: <strong>{x.when}</strong>
                      </div>
                    ))}
                  </td>
                  <td className="small nowrap">{a.used} раз</td>
                  <td className="ops">
                    <div>
                      <Badge tone={REVIEW[a.review][1]}>
                        {REVIEW[a.review][0]}
                      </Badge>
                    </div>
                    {a.reviewed_by && (
                      <div className="muted small">
                        {a.reviewed_by}
                        {a.reviewed_at && `, ${dateTime(a.reviewed_at)}`}
                      </div>
                    )}
                    {canEdit && (
                      <div className="ops-row">
                        {a.review !== "approved" && (
                          <button
                            className="btn btn-sm"
                            disabled={review.isPending}
                            onClick={() =>
                              review.mutate({ id: a.id, action: "approve" })
                            }
                          >
                            Одобрить и сохранить
                          </button>
                        )}
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => setFixing(a)}
                        >
                          Исправить
                        </button>
                        {a.review !== "hidden" && (
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={review.isPending}
                            onClick={() =>
                              review.mutate({ id: a.id, action: "hide" })
                            }
                          >
                            Скрыть
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {fixing && <FixModal answer={fixing} onClose={() => setFixing(null)} />}
    </>
  );
}

function FixModal({
  answer,
  onClose,
}: {
  answer: AiAnswerRow;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [verdict, setVerdict] = useState<Verdict>(answer.verdict);
  const [text, setText] = useState(answer.text);
  const m = useMutation({
    mutationFn: () =>
      api(`/staff/ai/answers/${answer.id}/review`, {
        method: "POST",
        body: { action: "fix", verdict, text },
      }),
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
    <Modal title="Исправить AI-ответ" onClose={onClose} wide>
      <form onSubmit={submit}>
        <ul className="compat-products">
          {answer.products.map((p) => (
            <li key={p.product_id}>{p.name}</li>
          ))}
        </ul>
        <Field label="Метка">
          <div className="segmented">
            {VERDICTS.map((v) => (
              <button
                type="button"
                key={v}
                className={verdict === v ? "is-on" : ""}
                onClick={() => setVerdict(v)}
              >
                {VERDICT[v][0]}
              </button>
            ))}
          </div>
        </Field>
        <Field
          label={`Текст ответа — на языке клиента (${answer.lang.toUpperCase()})`}
          hint="Сохранится как ответ специалиста: следующие покупатели с этим набором получат его сразу."
        >
          <textarea
            rows={6}
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
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
