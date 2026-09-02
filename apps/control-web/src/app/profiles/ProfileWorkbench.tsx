"use client";

import { useState } from "react";

import styles from "./profile.module.css";

const sameOriginRequest = globalThis.fetch.bind(globalThis);

type ViewState = "idle" | "loading" | "submitting" | "ready" | "error";

interface ProfileView {
  readonly id: string;
  readonly state: "PROPOSED" | "APPROVAL_PENDING" | "LOCKED" | "REJECTED" | "SUPERSEDED";
  readonly revision: number;
  readonly reviewDigest: string;
  readonly compilerWheelDigest: string;
  readonly catalogDigest: string;
  readonly profile: {
    readonly spec: {
      readonly state: "PLANNED";
      readonly selectedHarnessIds: readonly string[];
      readonly selectedModuleIds: readonly string[];
      readonly selectedProviderIds: readonly string[];
      readonly proposedSelectors: readonly unknown[];
    };
  };
  readonly approval: null | { readonly id: string; readonly state: string; readonly digest: string };
  readonly lock: null | { readonly id: string; readonly digest: string; readonly lockedAt: string };
  readonly bundle: null | { readonly id: string; readonly state: string; readonly sourceFreshness: string };
  readonly evidenceAxes: Readonly<Record<string, string>>;
}

interface ApprovalView {
  readonly id: string;
  readonly state: string;
  readonly approvedDecisionCount: number;
  readonly eligibleReviewerCount: number;
  readonly resource: { readonly spec: { readonly requiredDecisions: number; readonly expiresAt: string } };
}

interface BundleView {
  readonly id: string;
  readonly state: string;
  readonly sourceFreshness: string;
  readonly operation: { readonly metadata: { readonly id: string }; readonly spec: { readonly state: string; readonly operationType: string } };
  readonly evidenceBoundary: string;
}

function csrfToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="planeon-csrf-token"]')?.content ?? "";
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string") {
    return `${fallback} (${payload.code.replaceAll("_", " ").toLowerCase()})`;
  }
  return fallback;
}

function namedList(items: readonly string[], empty: string) {
  if (items.length === 0) return <p className={styles.empty}>{empty}</p>;
  return <ul className={styles.namedList}>{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

export function ProfileWorkbench() {
  const [profileId, setProfileId] = useState("");
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [profileEtag, setProfileEtag] = useState("");
  const [approval, setApproval] = useState<ApprovalView | null>(null);
  const [approvalEtag, setApprovalEtag] = useState("");
  const [bundle, setBundle] = useState<BundleView | null>(null);
  const [explanation, setExplanation] = useState("");
  const [viewState, setViewState] = useState<ViewState>("idle");
  const [message, setMessage] = useState("Enter an immutable compiled profile ID to begin review.");

  function secureHeaders(etag: string): HeadersInit {
    const csrf = csrfToken();
    if (!csrf) throw new Error("Your secure session must be refreshed before a mutation.");
    return {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      "if-match": etag,
      "x-csrf-token": csrf,
    };
  }

  async function fetchProfile(id: string): Promise<ProfileView> {
    const result = await sameOriginRequest(`/api/v1alpha1/profiles/${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store" });
    const payload = await result.json() as ProfileView;
    if (!result.ok) throw new Error(errorMessage(payload, "The profile could not be loaded."));
    setProfile(payload);
    setProfileEtag(result.headers.get("etag") ?? "");
    return payload;
  }

  async function fetchApproval(id: string): Promise<void> {
    const result = await sameOriginRequest(`/api/v1alpha1/profiles/${encodeURIComponent(id)}/approval`, { credentials: "same-origin", cache: "no-store" });
    if (result.status === 404) return;
    const payload = await result.json() as ApprovalView;
    if (!result.ok) throw new Error(errorMessage(payload, "Approval state could not be loaded."));
    setApproval(payload);
    setApprovalEtag(result.headers.get("etag") ?? "");
  }

  async function load(): Promise<void> {
    if (!profileId.trim()) return;
    setViewState("loading");
    setMessage("Verifying all six compiled outputs…");
    setApproval(null);
    setBundle(null);
    try {
      const id = profileId.trim();
      const loaded = await fetchProfile(id);
      const explanationResult = await sameOriginRequest(`/api/v1alpha1/profiles/${encodeURIComponent(id)}/explanation`, { credentials: "same-origin", cache: "no-store" });
      if (!explanationResult.ok) throw new Error("The byte-verified explanation could not be loaded.");
      setExplanation(await explanationResult.text());
      if (loaded.approval) await fetchApproval(id);
      if (loaded.bundle) {
        const result = await sameOriginRequest(`/api/v1alpha1/bundles/${encodeURIComponent(loaded.bundle.id)}`, { credentials: "same-origin", cache: "no-store" });
        if (result.ok) setBundle(await result.json() as BundleView);
      }
      setViewState("ready");
      setMessage("The stored bytes and every immutable binding match this review projection.");
    } catch (error) {
      setViewState("error");
      setMessage(error instanceof Error ? error.message : "The profile could not be loaded.");
    }
  }

  async function requestApproval(): Promise<void> {
    if (!profile || !profileEtag) return;
    await mutate(`/api/v1alpha1/profiles/${encodeURIComponent(profile.id)}/approve`, {}, profileEtag, "Approval requested.", async (result) => {
      setApproval(await result.json() as ApprovalView);
      setApprovalEtag(result.headers.get("etag") ?? "");
      await fetchProfile(profile.id);
    });
  }

  async function decide(decision: "APPROVE" | "REJECT"): Promise<void> {
    if (!profile || !approval || !approvalEtag) return;
    await mutate(
      `/api/v1alpha1/profiles/${encodeURIComponent(profile.id)}/approval/decision`,
      { decision, reasonCode: decision === "APPROVE" ? "REVIEW_COMPLETE" : "REQUIREMENTS_REJECTED" },
      approvalEtag,
      `${decision === "APPROVE" ? "Approval" : "Rejection"} decision recorded.`,
      async (result) => {
        setApproval(await result.json() as ApprovalView);
        setApprovalEtag(result.headers.get("etag") ?? "");
        await fetchProfile(profile.id);
      },
    );
  }

  async function lock(): Promise<void> {
    if (!profile || !profileEtag) return;
    await mutate(`/api/v1alpha1/profiles/${encodeURIComponent(profile.id)}/lock`, {}, profileEtag, "The canonical profile lock is immutable.", async () => {
      await fetchProfile(profile.id);
    });
  }

  async function requestBundle(): Promise<void> {
    if (!profile || !profileEtag) return;
    await mutate("/api/v1alpha1/bundles", { profileId: profile.id }, profileEtag, "One durable bundle-build handoff was recorded.", async (result) => {
      setBundle(await result.json() as BundleView);
      await fetchProfile(profile.id);
    });
  }

  async function mutate(
    path: string,
    input: Record<string, unknown>,
    etag: string,
    success: string,
    accept: (result: Response) => Promise<void>,
  ): Promise<void> {
    setViewState("submitting");
    setMessage("Applying the guarded transition…");
    try {
      const result = await sameOriginRequest(path, { method: "POST", credentials: "same-origin", headers: secureHeaders(etag), body: JSON.stringify(input) });
      if (!result.ok) throw new Error(errorMessage(await result.json(), "The transition was refused."));
      await accept(result);
      setViewState("ready");
      setMessage(success);
    } catch (error) {
      setViewState("error");
      setMessage(error instanceof Error ? error.message : "The transition was refused.");
    }
  }

  const spec = profile?.profile.spec;

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <span className={styles.brand}>Planeon · Harness Engineering</span>
        <nav aria-label="Control-plane workspaces"><a href="/demands">Demand</a><a aria-current="page" href="/profiles">Profile review</a></nav>
      </header>
      <main className={styles.main} id="main-content" tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="profile-title">
          <div><p className={styles.eyebrow}>Compiled profile control</p><h1 id="profile-title">Review the exact plan. Approve the lock. Handoff once.</h1></div>
          <p>Every action re-hashes the six stored compiler outputs. A profile lock is configuration authority—not evidence that an artifact exists or a harness is running.</p>
        </section>

        <section className={styles.lookup} aria-labelledby="lookup-title">
          <div><p className={styles.step}>01 · Locate</p><h2 id="lookup-title">Immutable profile ID</h2></div>
          <label><span>Profile ID</span><input value={profileId} onChange={(event) => setProfileId(event.target.value)} placeholder="profile.enterprise-target" spellCheck={false} /></label>
          <button type="button" onClick={() => void load()} disabled={viewState === "loading" || viewState === "submitting"}>Verify & open</button>
        </section>

        <div className={styles.status} data-state={viewState} aria-live="polite" aria-busy={viewState === "loading" || viewState === "submitting"}>{message}</div>

        {profile && spec && (
          <>
            <section className={styles.commandStrip} aria-label="Profile actions">
              <div><span>Internal state</span><strong>{profile.state.replaceAll("_", " ")}</strong></div>
              <div><span>Compiler state</span><strong>{spec.state}</strong></div>
              <div><span>Revision</span><strong>{profile.revision}</strong></div>
              <div className={styles.actions}>
                {profile.state === "PROPOSED" && <button type="button" onClick={() => void requestApproval()} disabled={spec.proposedSelectors.length > 0}>Request approval</button>}
                {profile.state === "APPROVAL_PENDING" && approval?.state === "APPROVED" && <button type="button" onClick={() => void lock()}>Lock profile</button>}
                {profile.state === "LOCKED" && !profile.bundle && <button type="button" onClick={() => void requestBundle()}>Request bundle build</button>}
              </div>
            </section>

            <div className={styles.grid}>
              <section className={styles.panel} aria-labelledby="selection-title">
                <p className={styles.step}>02 · Named selection</p><h2 id="selection-title">Harness composition</h2>
                <h3>Harnesses</h3>{namedList(spec.selectedHarnessIds, "No harness was selected.")}
                <h3>Modules</h3>{namedList(spec.selectedModuleIds, "No module was selected.")}
                <h3>Providers</h3>{namedList(spec.selectedProviderIds, "No provider was selected.")}
                {spec.proposedSelectors.length > 0 && <p className={styles.warning}>Unresolved provider selectors block approval and locking. Replace this profile from a newly approved demand with explicit choices.</p>}
              </section>

              <section className={styles.panel} aria-labelledby="explanation-title">
                <p className={styles.step}>03 · Exact explanation</p><h2 id="explanation-title">Compiler rationale</h2>
                <pre className={styles.explanation}>{explanation}</pre>
                <dl className={styles.bindings}>
                  <div><dt>Review digest</dt><dd>{profile.reviewDigest}</dd></div>
                  <div><dt>Catalog</dt><dd>{profile.catalogDigest}</dd></div>
                  <div><dt>Compiler wheel</dt><dd>{profile.compilerWheelDigest}</dd></div>
                </dl>
              </section>

              <aside className={styles.side} aria-labelledby="governance-title">
                <p className={styles.step}>04 · Governance</p>
                <h2 id="governance-title">Approval & handoff</h2>
                {!approval && <p>No profile approval exists.</p>}
                {approval && <div className={styles.approval}><strong>{approval.state}</strong><span>{approval.approvedDecisionCount} / {approval.resource.spec.requiredDecisions} distinct approvals</span><span>Expires {approval.resource.spec.expiresAt}</span>{approval.state === "PENDING" && <div className={styles.actions}><button className={styles.secondary} type="button" onClick={() => void decide("REJECT")}>Reject</button><button type="button" onClick={() => void decide("APPROVE")}>Approve</button></div>}</div>}
                {profile.lock && <dl className={styles.bindings}><div><dt>Lock</dt><dd>{profile.lock.digest}</dd></div><div><dt>Locked at</dt><dd>{profile.lock.lockedAt}</dd></div></dl>}
                {bundle && <div className={styles.bundle}><strong>{bundle.state.replaceAll("_", " ")}</strong><span>{bundle.operation.spec.operationType} · {bundle.operation.spec.state}</span><span>Source freshness: {bundle.sourceFreshness}</span><small>{bundle.evidenceBoundary.replaceAll("_", " ")}</small></div>}
              </aside>
            </div>

            <section className={styles.boundaries} aria-labelledby="boundary-title">
              <div><p className={styles.step}>Evidence boundary</p><h2 id="boundary-title">What this page proves—and what it does not</h2></div>
              <dl>{Object.entries(profile.evidenceAxes).map(([axis, status]) => <div key={axis}><dt>{axis.replace(/([A-Z])/g, " $1")}</dt><dd data-status={status}>{status.replaceAll("_", " ")}</dd></div>)}</dl>
              <p>Compilation, approval, locking, and a source-reported signature are separate from artifact SBOM, local signature verification, deployment, runtime health, security, assurance, and tenant acceptance.</p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
