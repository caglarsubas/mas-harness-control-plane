"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import styles from "./questionnaire.module.css";

const sameOriginRequest = globalThis.fetch.bind(globalThis);

interface PackItem {
  readonly packId: string;
  readonly packVersion: string;
  readonly title: string;
  readonly industry: string;
  readonly stages: readonly { readonly id: string; readonly questionCount: number }[];
}

function csrfToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="planeon-csrf-token"]')?.content ?? "";
}

export function QuestionnaireCatalogue() {
  const router = useRouter();
  const [items, setItems] = useState<readonly PackItem[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [message, setMessage] = useState("");
  const [starting, setStarting] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void sameOriginRequest("/api/v1alpha1/questionnaires", { credentials: "same-origin", cache: "no-store" })
      .then(async (result) => {
        if (!result.ok) throw new Error("The admitted pack catalogue is unavailable.");
        const payload = await result.json() as { items?: PackItem[] };
        if (!active) return;
        const next = payload.items ?? [];
        setItems(next);
        setState(next.length ? "ready" : "empty");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMessage(error instanceof Error ? error.message : "The admitted pack catalogue is unavailable.");
        setState("error");
      });
    return () => { active = false; };
  }, []);

  async function start(pack: PackItem): Promise<void> {
    setStarting(pack.packId);
    setMessage("");
    try {
      const csrf = csrfToken();
      if (!csrf) throw new Error("Your secure session needs to be refreshed before starting.");
      const result = await sameOriginRequest("/api/v1alpha1/sessions", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ packId: pack.packId, packVersion: pack.packVersion }),
      });
      if (!result.ok) throw new Error("The questionnaire session could not be started.");
      const session = await result.json() as { id: string; currentStageId: string };
      router.push(`/questionnaires/${session.id}/${session.currentStageId}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The questionnaire session could not be started.");
      setStarting(null);
    }
  }

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <span className={styles.brand}>Planeon · Harness Engineering</span>
        <span className={styles.security}>Local-first · tenant isolated · signed packs only</span>
      </header>
      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="questionnaire-title">
          <div>
            <p className={styles.eyebrow}>Guided enterprise setup</p>
            <h1 id="questionnaire-title">Build the right harness ecosystem, in the right order.</h1>
            <p>Begin with business ownership and evidence. The journey then qualifies data, governance, integrations, harness demand, and your deployment environment before compilation.</p>
          </div>
          <aside className={styles.assurance} aria-label="Release assurance">
            <strong>Only admitted releases appear here.</strong>
            <span>Every industry pack is locally verified, digest-bound, purpose-scoped, and signed by an active trusted key.</span>
          </aside>
        </section>

        <div className={styles.status} aria-live="polite" aria-busy={state === "loading"}>
          {state === "loading" && "Loading admitted industry packs…"}
          {state === "error" && <div className={styles.error} role="alert">{message}</div>}
          {message && state !== "error" && <div className={styles.error} role="alert">{message}</div>}
        </div>

        {state === "empty" && (
          <section className={styles.empty}>
            <h2>No admitted industry pack yet</h2>
            <p>An operator must provide a retained, signed local release. Unsigned source manifests never become tenant-visible.</p>
          </section>
        )}

        {state === "ready" && (
          <section className={styles.packGrid} aria-label="Admitted industry packs">
            {items.map((pack) => (
              <article className={styles.packCard} key={`${pack.packId}@${pack.packVersion}`}>
                <div className={styles.packMeta}><span>{pack.industry}</span><span>v{pack.packVersion}</span></div>
                <h2>{pack.title}</h2>
                <p>Eight ordered stages · {pack.stages.reduce((total, stage) => total + stage.questionCount, 0)} declared questions</p>
                <div className={styles.stageDots} aria-label="Eight journey stages">
                  {pack.stages.map((stage) => <span className={styles.stageDot} key={stage.id} />)}
                </div>
                <button className={styles.button} type="button" disabled={starting !== null} onClick={() => void start(pack)}>
                  {starting === pack.packId ? "Starting…" : "Start guided setup"}
                </button>
              </article>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
