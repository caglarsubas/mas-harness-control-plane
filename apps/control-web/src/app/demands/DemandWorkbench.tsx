"use client";

import { useMemo, useState } from "react";

import styles from "./demand.module.css";

const sameOriginRequest = globalThis.fetch.bind(globalThis);
const EMPTY_DIGEST = "sha256:";

type Decision = "ACCEPT" | "REJECT";
type ViewState = "idle" | "submitting" | "ready" | "error";

interface PrerequisiteChoice {
  readonly id: string;
  readonly title: string;
  readonly explanation: string;
  readonly decision: Decision;
}

interface Finding {
  readonly findingId: string;
  readonly reasonCode: string;
  readonly subjectId: string;
  readonly severity: "BLOCKING" | "PASS";
}

interface DemandView {
  readonly id: string;
  readonly state: string;
  readonly revision: number;
  readonly findings: readonly Finding[];
  readonly approvalId: string | null;
}

interface ApprovalView {
  readonly id: string;
  readonly state: string;
  readonly approvedDecisionCount: number;
  readonly eligibleReviewerCount: number;
  readonly resource: { readonly spec: { readonly requiredDecisions: number; readonly expiresAt: string } };
}

function csrfToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="planeon-csrf-token"]')?.content ?? "";
}

function tokens(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].sort();
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string") {
    return `${fallback} (${payload.code.replaceAll("_", " ").toLowerCase()})`;
  }
  return fallback;
}

export function DemandWorkbench() {
  const [viewState, setViewState] = useState<ViewState>("idle");
  const [message, setMessage] = useState("");
  const [demand, setDemand] = useState<DemandView | null>(null);
  const [demandEtag, setDemandEtag] = useState("");
  const [approval, setApproval] = useState<ApprovalView | null>(null);
  const [approvalEtag, setApprovalEtag] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [sessionRevision, setSessionRevision] = useState("1");
  const [answerSetId, setAnswerSetId] = useState("answer-set.current");
  const [answerSetDigest, setAnswerSetDigest] = useState(EMPTY_DIGEST);
  const [readinessId, setReadinessId] = useState("readiness.current");
  const [readinessDigest, setReadinessDigest] = useState(EMPTY_DIGEST);
  const [environmentDigest, setEnvironmentDigest] = useState(EMPTY_DIGEST);
  const [capabilities, setCapabilities] = useState("domain.semantic, data.integration");
  const [prerequisites, setPrerequisites] = useState<readonly PrerequisiteChoice[]>([
    { id: "knowledge.domain-semantic", title: "Domain & semantic foundation", explanation: "A governed vocabulary and business meaning layer required before retrieval or automation.", decision: "ACCEPT" },
    { id: "knowledge.data-integration", title: "Data integration & provenance", explanation: "Traceable source connectivity and readiness evidence required before compilation.", decision: "ACCEPT" },
  ]);

  const blockingCount = useMemo(() => demand?.findings.filter((finding) => finding.severity === "BLOCKING").length ?? 0, [demand]);

  function updateDecision(id: string, decision: Decision): void {
    setPrerequisites((current) => current.map((item) => item.id === id ? { ...item, decision } : item));
  }

  function secureHeaders(etag?: string): HeadersInit {
    const csrf = csrfToken();
    if (!csrf) throw new Error("Your secure session must be refreshed before a mutation.");
    return {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      "x-csrf-token": csrf,
      ...(etag ? { "if-match": etag } : {}),
    };
  }

  async function create(): Promise<void> {
    setViewState("submitting");
    setMessage("");
    try {
      const body = {
        source: {
          questionnaireSessionId: sessionId,
          questionnaireSessionRevision: Number(sessionRevision),
          questionnaireAnswerSetId: answerSetId,
          questionnaireAnswerSetDigest: answerSetDigest,
          readinessAssessmentId: readinessId,
          readinessAssessmentDigest: readinessDigest,
        },
        requestedCapabilities: tokens(capabilities),
        proposedPrerequisiteHarnessIds: prerequisites.map((item) => item.id),
        prerequisiteDecisions: prerequisites.map((item) => ({
          harnessId: item.id,
          decision: item.decision,
          reasonCode: item.decision === "ACCEPT" ? "TENANT_ACCEPTED" : "TENANT_REJECTED",
        })),
        environment: {
          deploymentMode: "self-managed",
          architecture: "platform-supplied",
          operatingSystem: "linux",
          kubernetesDistribution: "openshift",
          capabilities: ["network.local-only"],
          attestationDigest: environmentDigest,
          signatureStatus: "VERIFIED",
        },
        assuranceSubjects: { harnessIds: prerequisites.map((item) => item.id), capabilityIds: tokens(capabilities) },
        executionBudget: { maxConcurrentTasks: 4, maxTaskSeconds: 900, maxRetries: 2, maxToolCalls: 20, maxModelTokens: 120000 },
      };
      const result = await sameOriginRequest("/api/v1alpha1/demands", {
        method: "POST", credentials: "same-origin", headers: secureHeaders(), body: JSON.stringify(body),
      });
      const payload = await result.json() as DemandView;
      if (!result.ok) throw new Error(errorMessage(payload, "The demand could not be created."));
      setDemand(payload);
      setDemandEtag(result.headers.get("etag") ?? "");
      setViewState("ready");
      setMessage("Demand draft created. Validate its current source evidence before requesting approval.");
    } catch (error) {
      setViewState("error");
      setMessage(error instanceof Error ? error.message : "The demand could not be created.");
    }
  }

  async function mutateDemand(action: "validate" | "approve"): Promise<void> {
    if (!demand || !demandEtag) return;
    setViewState("submitting");
    setMessage("");
    try {
      const result = await sameOriginRequest(`/api/v1alpha1/demands/${demand.id}/${action}`, {
        method: "POST", credentials: "same-origin", headers: secureHeaders(demandEtag), body: "{}",
      });
      const payload = await result.json() as DemandView | ApprovalView;
      if (!result.ok) throw new Error(errorMessage(payload, action === "validate" ? "Demand validation was blocked." : "Approval could not be requested."));
      if (action === "validate") {
        setDemand(payload as DemandView);
        setDemandEtag(result.headers.get("etag") ?? "");
        setMessage((payload as DemandView).state === "VALIDATED" ? "Demand validated. It is ready for policy-admitted approval." : "Demand remains blocked. Review the findings below.");
      } else {
        setApproval(payload as ApprovalView);
        setApprovalEtag(result.headers.get("etag") ?? "");
        const refreshed = await sameOriginRequest(`/api/v1alpha1/demands/${demand.id}`, { credentials: "same-origin", cache: "no-store" });
        if (refreshed.ok) {
          setDemand(await refreshed.json() as DemandView);
          setDemandEtag(refreshed.headers.get("etag") ?? "");
        }
        setMessage("Approval requested. Only distinct policy-admitted reviewers can complete the quorum.");
      }
      setViewState("ready");
    } catch (error) {
      setViewState("error");
      setMessage(error instanceof Error ? error.message : "The demand mutation was refused.");
    }
  }

  async function decide(decision: "APPROVE" | "REJECT"): Promise<void> {
    if (!approval || !approvalEtag) return;
    setViewState("submitting");
    setMessage("");
    try {
      const result = await sameOriginRequest(`/api/v1alpha1/approvals/${approval.id}/decision`, {
        method: "POST",
        credentials: "same-origin",
        headers: secureHeaders(approvalEtag),
        body: JSON.stringify({ decision, reasonCode: decision === "APPROVE" ? "REVIEW_COMPLETE" : "REQUIREMENTS_REJECTED" }),
      });
      const payload = await result.json() as ApprovalView;
      if (!result.ok) throw new Error(errorMessage(payload, "The reviewer decision was refused."));
      setApproval(payload);
      setApprovalEtag(result.headers.get("etag") ?? "");
      setViewState("ready");
      setMessage(payload.state === "PENDING" ? "Decision recorded; the distinct-reviewer quorum is still pending." : `Approval is now ${payload.state.toLowerCase()}.`);
    } catch (error) {
      setViewState("error");
      setMessage(error instanceof Error ? error.message : "The reviewer decision was refused.");
    }
  }

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <span className={styles.brand}>Planeon · Harness Engineering</span>
        <a href="/questionnaires">Questionnaire journey</a>
      </header>
      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="demand-title">
          <div>
            <p className={styles.eyebrow}>Demand & approval control</p>
            <h1 id="demand-title">Turn declared intent into an explicit, reviewable demand.</h1>
            <p>Sources are re-resolved locally. Prerequisites are never silently accepted. Approval requires distinct authenticated reviewers admitted by current policy.</p>
          </div>
          <ol className={styles.lifecycle} aria-label="Demand lifecycle">
            {["Draft", "Validated", "Approval pending", "Approved"].map((state, index) => (
              <li key={state} data-current={demand?.state.replaceAll("_", " ").toLowerCase() === state.toLowerCase()}><span>{index + 1}</span>{state}</li>
            ))}
          </ol>
        </section>

        <div className={styles.status} aria-live="polite" aria-busy={viewState === "submitting"}>
          {viewState === "submitting" ? "Applying the guarded transition…" : message}
        </div>

        <div className={styles.workspace}>
          <section className={styles.panel} aria-labelledby="source-heading">
            <div className={styles.panelHeading}>
              <p className={styles.step}>01 · Evidence binding</p>
              <h2 id="source-heading">Current source references</h2>
              <p>Only IDs and immutable digests cross this boundary. Answer values and evidence bytes remain in their owning stores.</p>
            </div>
            <div className={styles.formGrid}>
              <label>Questionnaire session ID<input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="00000000-0000-4000-8000-000000000000" /></label>
              <label>Session revision<input inputMode="numeric" value={sessionRevision} onChange={(event) => setSessionRevision(event.target.value)} /></label>
              <label>Answer-set ID<input value={answerSetId} onChange={(event) => setAnswerSetId(event.target.value)} /></label>
              <label>Answer-set digest<input value={answerSetDigest} onChange={(event) => setAnswerSetDigest(event.target.value)} spellCheck={false} /></label>
              <label>Readiness assessment ID<input value={readinessId} onChange={(event) => setReadinessId(event.target.value)} /></label>
              <label>Readiness digest<input value={readinessDigest} onChange={(event) => setReadinessDigest(event.target.value)} spellCheck={false} /></label>
              <label>Environment attestation digest<input value={environmentDigest} onChange={(event) => setEnvironmentDigest(event.target.value)} spellCheck={false} /></label>
              <label>Requested capabilities<input value={capabilities} onChange={(event) => setCapabilities(event.target.value)} aria-describedby="capability-help" /></label>
            </div>
            <p className={styles.help} id="capability-help">Comma-separated public demand capabilities. Provider selectors and environment facts are separate contracts.</p>
          </section>

          <section className={styles.panel} aria-labelledby="prerequisite-heading">
            <div className={styles.panelHeading}>
              <p className={styles.step}>02 · Explicit decisions</p>
              <h2 id="prerequisite-heading">Proposed prerequisites</h2>
              <p>Each proposal needs one visible tenant decision. A rejection remains a blocking fact; it never falls back to acceptance.</p>
            </div>
            <div className={styles.prerequisites}>
              {prerequisites.map((item) => (
                <fieldset key={item.id} className={styles.prerequisite}>
                  <legend>{item.title}</legend>
                  <code>{item.id}</code>
                  <p>{item.explanation}</p>
                  <div className={styles.segmented}>
                    <label><input type="radio" name={item.id} checked={item.decision === "ACCEPT"} onChange={() => updateDecision(item.id, "ACCEPT")} />Accept</label>
                    <label><input type="radio" name={item.id} checked={item.decision === "REJECT"} onChange={() => updateDecision(item.id, "REJECT")} />Reject</label>
                  </div>
                </fieldset>
              ))}
            </div>
            {!demand && <button className={styles.primaryButton} type="button" disabled={viewState === "submitting"} onClick={() => void create()}>Create demand draft</button>}
          </section>

          <aside className={styles.summary} aria-labelledby="summary-heading">
            <p className={styles.step}>03 · Guarded lifecycle</p>
            <h2 id="summary-heading">Demand status</h2>
            {!demand && <div className={styles.empty}><strong>No draft yet</strong><span>Bind the current evidence and make every prerequisite decision.</span></div>}
            {demand && (
              <>
                <span className={styles.badge} data-state={demand.state}>{demand.state.replaceAll("_", " ")}</span>
                <dl className={styles.metrics}>
                  <div><dt>Revision</dt><dd>{demand.revision}</dd></div>
                  <div><dt>Blocking findings</dt><dd>{blockingCount}</dd></div>
                </dl>
                <div className={styles.actions}>
                  {(demand.state === "DRAFT" || demand.state === "BLOCKED") && <button className={styles.primaryButton} type="button" onClick={() => void mutateDemand("validate")}>Validate current evidence</button>}
                  {demand.state === "VALIDATED" && <button className={styles.primaryButton} type="button" onClick={() => void mutateDemand("approve")}>Request policy approval</button>}
                </div>
                {demand.findings.length > 0 && (
                  <div className={styles.findings}>
                    <h3>Validation findings</h3>
                    <ul>{demand.findings.slice(-8).map((finding) => <li key={finding.findingId ?? `${finding.reasonCode}:${finding.subjectId}`}>{finding.reasonCode.replaceAll("_", " ").toLowerCase()} · {finding.subjectId}</li>)}</ul>
                  </div>
                )}
              </>
            )}
            {approval && (
              <section className={styles.approval} aria-labelledby="approval-heading">
                <h3 id="approval-heading">Approval quorum</h3>
                <strong>{approval.approvedDecisionCount} / {approval.resource.spec.requiredDecisions}</strong>
                <span>{approval.eligibleReviewerCount} eligible distinct reviewers · expires {approval.resource.spec.expiresAt}</span>
                <div className={styles.actions}>
                  <button className={styles.secondaryButton} type="button" disabled={approval.state !== "PENDING"} onClick={() => void decide("REJECT")}>Reject</button>
                  <button className={styles.primaryButton} type="button" disabled={approval.state !== "PENDING"} onClick={() => void decide("APPROVE")}>Approve</button>
                </div>
                <p className={styles.help}>The requester cannot review their own demand. These controls work only for an authenticated reviewer admitted by the stored policy binding.</p>
              </section>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}
