"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import styles from "../../questionnaire.module.css";

const sameOriginRequest = globalThis.fetch.bind(globalThis);

type Value = string | number | boolean | readonly string[];

interface Question {
  readonly id: string;
  readonly prompt: string;
  readonly responseType: "string" | "number" | "boolean" | "single-choice" | "multiple-choice";
  readonly required: boolean;
  readonly options: readonly string[];
}

interface Stage {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly questions: readonly Question[];
}

interface Pack {
  readonly packId: string;
  readonly packVersion: string;
  readonly title: string;
  readonly stages: readonly Stage[];
}

interface Session {
  readonly id: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly state: string;
  readonly currentStageId: string;
  readonly completedStageIds: readonly string[];
  readonly revision: number;
  readonly answers: readonly { readonly questionId: string; readonly value: Value }[];
  readonly findings: readonly {
    readonly findingId: string;
    readonly revision: number;
    readonly stageId: string;
    readonly questionId: string | null;
    readonly severity: "BLOCKING" | "PASS";
    readonly reasonCode: string;
  }[];
}

function csrfToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="planeon-csrf-token"]')?.content ?? "";
}

function title(value: string): string {
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export function QuestionnaireJourney({ sessionId, stageId }: { readonly sessionId: string; readonly stageId: string }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [pack, setPack] = useState<Pack | null>(null);
  const [etag, setEtag] = useState("");
  const [answers, setAnswers] = useState<Record<string, Value>>({});
  const [state, setState] = useState<"loading" | "ready" | "saving" | "reviewing" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([
      sameOriginRequest(`/api/v1alpha1/sessions/${sessionId}`, { credentials: "same-origin", cache: "no-store" }),
      sameOriginRequest("/api/v1alpha1/questionnaires", { credentials: "same-origin", cache: "no-store" }),
    ]).then(async ([sessionResponse, packResponse]) => {
      if (!sessionResponse.ok || !packResponse.ok) throw new Error("Your saved questionnaire could not be loaded.");
      const nextSession = await sessionResponse.json() as Session;
      const catalogue = await packResponse.json() as { items: Pack[] };
      const nextPack = catalogue.items.find((item) => item.packId === nextSession.packId && item.packVersion === nextSession.packVersion);
      if (!nextPack || !nextPack.stages.some((stage) => stage.id === stageId)) throw new Error("This questionnaire stage is unavailable.");
      if (!active) return;
      setSession(nextSession);
      setPack(nextPack);
      setEtag(sessionResponse.headers.get("etag") ?? "");
      setAnswers(Object.fromEntries(nextSession.answers.map((answer) => [answer.questionId, answer.value])));
      setState("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setMessage(error instanceof Error ? error.message : "Your saved questionnaire could not be loaded.");
      setState("error");
    });
    return () => { active = false; };
  }, [sessionId, stageId]);

  const stage = useMemo(() => pack?.stages.find((candidate) => candidate.id === stageId) ?? null, [pack, stageId]);
  const progress = session && pack ? Math.round((session.completedStageIds.length / pack.stages.length) * 100) : 0;

  function setValue(questionId: string, value: Value): void {
    setAnswers((current) => ({ ...current, [questionId]: value }));
  }

  function toggle(questionId: string, option: string, checked: boolean): void {
    const current = Array.isArray(answers[questionId]) ? answers[questionId] as readonly string[] : [];
    setValue(questionId, checked ? [...current, option] : current.filter((item) => item !== option));
  }

  async function mutate(kind: "save" | "review"): Promise<void> {
    if (!session || !stage || !etag) return;
    setState(kind === "save" ? "saving" : "reviewing");
    setMessage("");
    try {
      const csrf = csrfToken();
      if (!csrf) throw new Error("Your secure session needs to be refreshed before saving.");
      const endpoint = kind === "save"
        ? `/api/v1alpha1/sessions/${sessionId}/answers`
        : `/api/v1alpha1/sessions/${sessionId}/review`;
      const payload = kind === "save" ? {
        stageId,
        answers: stage.questions.filter((question) => question.id in answers).map((question) => ({
          questionId: question.id,
          value: answers[question.id],
          source: "TENANT_DECLARATION",
        })),
      } : {};
      const result = await sameOriginRequest(endpoint, {
        method: kind === "save" ? "PUT" : "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          "if-match": etag,
          "x-csrf-token": csrf,
        },
        body: JSON.stringify(payload),
      });
      if (!result.ok) {
        if (result.status === 412) throw new Error("A newer revision exists. Refresh before saving again.");
        throw new Error(kind === "save" ? "This stage could not be saved." : "Readiness review could not be completed.");
      }
      const next = await result.json() as Session;
      setSession(next);
      setEtag(result.headers.get("etag") ?? "");
      setState("ready");
      if (kind === "save" && next.currentStageId !== stageId) router.push(`/questionnaires/${sessionId}/${next.currentStageId}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The requested change could not be completed.");
      setState("ready");
    }
  }

  if (state === "loading") return <main className={styles.main} aria-live="polite" aria-busy="true">Restoring the latest saved revision…</main>;
  if (state === "error" || !session || !pack || !stage) return <main className={styles.main}><div className={styles.error} role="alert">{message}</div></main>;

  const busy = state === "saving" || state === "reviewing";
  const stageFindings = session.findings.filter((finding) => finding.revision === session.revision && finding.stageId === stageId && finding.severity === "BLOCKING");

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <span className={styles.brand}>Planeon · Guided setup</span>
        <span className={styles.security}>Revision {session.revision} · saved server-side</span>
      </header>
      <main className={styles.main}>
        <div className={styles.workspace}>
          <aside className={styles.sidebar} aria-label="Questionnaire progress">
            <p className={styles.eyebrow}>Eight-stage journey</p>
            <h1>{pack.title}</h1>
            <div className={styles.progress} aria-label={`${progress}% complete`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
              <div className={styles.progressFill} style={{ width: `${progress}%` }} />
            </div>
            <ol className={styles.stageList}>
              {pack.stages.map((item, index) => (
                <li key={item.id}>
                  <Link
                    className={styles.stageLink}
                    href={`/questionnaires/${sessionId}/${item.id}`}
                    aria-current={item.id === stageId ? "step" : undefined}
                    data-complete={session.completedStageIds.includes(item.id)}
                  >
                    <span className={styles.ordinal}>{index + 1}</span><span>{item.title}</span>
                  </Link>
                </li>
              ))}
            </ol>
          </aside>

          <section className={styles.panel} aria-labelledby="stage-title">
            <header className={styles.panelHeader}>
              <span className={styles.stateBadge}>{session.state.replaceAll("_", " ")}</span>
              <p className={styles.eyebrow}>Stage {pack.stages.findIndex((item) => item.id === stageId) + 1} of 8</p>
              <h2 id="stage-title">{stage.title}</h2>
              <p>{stage.purpose}</p>
            </header>

            {message && <div className={styles.error} role="alert">{message}</div>}
            {stageFindings.length > 0 && (
              <aside className={styles.findings} aria-labelledby="finding-title">
                <h3 id="finding-title">Items required before readiness</h3>
                <ul>{stageFindings.map((finding) => <li key={finding.findingId}>{finding.questionId ? title(finding.questionId) : finding.reasonCode}</li>)}</ul>
              </aside>
            )}

            <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void mutate("save"); }}>
              {stage.questions.length === 0 && <p className={styles.resumeNote}>This stage is informational for the selected pack. Save to record it as reviewed.</p>}
              {stage.questions.map((question) => (
                <div className={styles.field} key={question.id}>
                  {question.responseType === "multiple-choice" ? (
                    <fieldset className={styles.choiceGroup}>
                      <legend className={styles.legend}>{question.prompt}{question.required && <span className={styles.required}>Required</span>}</legend>
                      {question.options.map((option) => (
                        <label className={styles.choice} key={option}>
                          <input type="checkbox" checked={(answers[question.id] as readonly string[] | undefined)?.includes(option) ?? false} onChange={(event) => toggle(question.id, option, event.currentTarget.checked)} />
                          <span>{title(option)}</span>
                        </label>
                      ))}
                    </fieldset>
                  ) : (
                    <>
                      <label htmlFor={question.id}>{question.prompt}{question.required && <span className={styles.required}>Required</span>}</label>
                      {question.responseType === "string" && <textarea className={styles.textarea} id={question.id} value={String(answers[question.id] ?? "")} onChange={(event) => setValue(question.id, event.currentTarget.value)} />}
                      {question.responseType === "number" && <input className={styles.input} id={question.id} inputMode="decimal" type="number" value={typeof answers[question.id] === "number" ? String(answers[question.id]) : ""} onChange={(event) => setValue(question.id, event.currentTarget.valueAsNumber)} />}
                      {question.responseType === "boolean" && (
                        <select className={styles.select} id={question.id} value={typeof answers[question.id] === "boolean" ? String(answers[question.id]) : ""} onChange={(event) => setValue(question.id, event.currentTarget.value === "true")}>
                          <option value="">Select an answer</option><option value="true">Yes</option><option value="false">No</option>
                        </select>
                      )}
                      {question.responseType === "single-choice" && (
                        <select className={styles.select} id={question.id} value={String(answers[question.id] ?? "")} onChange={(event) => setValue(question.id, event.currentTarget.value)}>
                          <option value="">Select an answer</option>{question.options.map((option) => <option key={option} value={option}>{title(option)}</option>)}
                        </select>
                      )}
                    </>
                  )}
                </div>
              ))}
              <div className={styles.actions}>
                <button className={styles.button} type="submit" disabled={busy}>{state === "saving" ? "Saving revision…" : "Save and continue"}</button>
                <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => void mutate("review")}>{state === "reviewing" ? "Reviewing…" : "Review readiness"}</button>
              </div>
              <p className={styles.resumeNote}>Answers are tenant declarations. Do not enter credentials, secrets, or raw tenant records.</p>
            </form>
          </section>
        </div>
      </main>
    </div>
  );
}
