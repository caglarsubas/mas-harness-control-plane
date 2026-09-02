import type { AggregateState, EvidenceAxis, HarnessStatusProjection, HarnessSummary, SelectionState, TenantHarnessOverview } from "../../lib/harness-status/contracts";
import { AGGREGATE_STATES, EVIDENCE_AXES, SELECTION_STATES } from "../../lib/harness-status/contracts";
import { HARNESSES, PLANES } from "../../lib/harness-status/taxonomy";
import { HarnessOnion } from "./HarnessOnion";
import styles from "./overview.module.css";

export interface StatusFilters {
  readonly state: AggregateState | "ALL";
  readonly axis: EvidenceAxis | "ALL";
  readonly selection: SelectionState | "ALL";
}

export function parseFilters(query: Readonly<Record<string, string | string[] | undefined>>): StatusFilters {
  const one = (value: string | string[] | undefined) => typeof value === "string" ? value : "ALL";
  const state = one(query.state);
  const axis = one(query.axis);
  const selection = one(query.selection);
  return Object.freeze({
    state: (state === "ALL" || AGGREGATE_STATES.includes(state as AggregateState) ? state : "ALL") as StatusFilters["state"],
    axis: (axis === "ALL" || EVIDENCE_AXES.includes(axis as EvidenceAxis) ? axis : "ALL") as StatusFilters["axis"],
    selection: (selection === "ALL" || SELECTION_STATES.includes(selection as SelectionState) ? selection : "ALL") as StatusFilters["selection"],
  });
}

function digest(value: string): string {
  return `${value.slice(0, 15)}…${value.slice(-8)}`;
}

function matches(summary: HarnessSummary, projection: HarnessStatusProjection | undefined, filters: StatusFilters): boolean {
  return (filters.state === "ALL" || summary.aggregateState === filters.state)
    && (filters.selection === "ALL" || summary.selectionState === filters.selection)
    && (filters.axis === "ALL" || projection?.spec.axes.some((axis) => axis.axis === filters.axis && axis.state !== "NOT_APPLICABLE") === true);
}

function statusLabel(value: string): string {
  return value.replaceAll("_", " ");
}

export function OverviewPage({ overview, harnesses, filters, operatorScope = false }: { readonly overview: TenantHarnessOverview; readonly harnesses: readonly HarnessStatusProjection[]; readonly filters: StatusFilters; readonly operatorScope?: boolean }) {
  if (overview.spec.empty || !overview.binding || !overview.spec.freshness) return <EmptyOverview overview={overview} />;
  const visible = overview.spec.harnesses.filter((summary) => matches(summary, harnesses.find((projection) => projection.spec.harnessId === summary.harnessId), filters));
  const visibleIds = new Set(visible.map((summary) => summary.harnessId));
  const selectedAxis = filters.axis === "ALL" ? null : filters.axis;
  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <a className={styles.brand} href="/overview">Planeon <span>Harness control</span></a>
        <nav aria-label="Control plane"><a aria-current={operatorScope ? undefined : "page"} href="/overview">Tenant overview</a><a aria-current={operatorScope ? "page" : undefined} href="/organizations">Organizations</a><a href="/profiles">Profile review</a></nav>
      </header>
      <main className={styles.main} id="main-content" tabIndex={-1}>
        <nav className={styles.breadcrumbs} aria-label="Breadcrumb"><a href={operatorScope ? "/organizations" : "/overview"}>{operatorScope ? "Organizations" : "Overview"}</a>{operatorScope && <span aria-current="page">{overview.spec.displayName}</span>}</nav>
        {operatorScope && <p className={styles.previewNotice} role="note">Synthetic operator preview. Production organization data requires an audited organization:portfolio:view decision.</p>}
        <section className={styles.hero} aria-labelledby="overview-title">
          <div>
            <p className={styles.eyebrow}>Organization · {overview.spec.organizationId}</p>
            <h1 id="overview-title">{overview.spec.displayName}</h1>
            <p className={styles.lede}>One evidence-led view across four planes and sixteen modular harnesses. Status remains separate from installation authority and tenant acceptance.</p>
          </div>
          <dl className={styles.heroFacts}>
            <div><dt>Overall state</dt><dd data-state={overview.spec.aggregateState}>{statusLabel(overview.spec.aggregateState)}</dd></div>
            <div><dt>Freshness</dt><dd data-state={overview.spec.freshness.state}>{statusLabel(overview.spec.freshness.state)}</dd></div>
            <div><dt>Deployment</dt><dd>{statusLabel(overview.spec.deploymentMode)}</dd></div>
            <div><dt>Isolation</dt><dd>{statusLabel(overview.spec.isolationBoundary)}</dd></div>
          </dl>
        </section>

        {overview.spec.freshness.state !== "CURRENT" && <div className={styles.staleBanner} role="alert"><strong>Current health is withheld.</strong> Last verified projection: {overview.spec.freshness.projectedAt}. Source state: {statusLabel(overview.spec.freshness.state)}.</div>}

        <section className={styles.bindingStrip} aria-label="Immutable projection bindings">
          <div><span>Profile</span><code title={overview.binding.profileDigest}>{digest(overview.binding.profileDigest)}</code></div>
          <div><span>Bundle</span><code title={overview.binding.bundleDigest}>{digest(overview.binding.bundleDigest)}</code></div>
          <div><span>Release</span><code title={overview.binding.releaseDigest}>{digest(overview.binding.releaseDigest)}</code></div>
          <div><span>Observed generation</span><strong>{overview.binding.observedGeneration}</strong></div>
          <div><span>Fresh until</span><time dateTime={overview.binding.freshUntil}>{overview.binding.freshUntil}</time></div>
        </section>

        <section className={styles.findings} aria-labelledby="findings-title">
          <div><p className={styles.eyebrow}>Priority queue</p><h2 id="findings-title">Findings that need a decision</h2></div>
          {overview.spec.priorityFindings.length === 0 ? <p>No blocking findings in this verified projection.</p> : <ol>{overview.spec.priorityFindings.map((finding) => <li key={finding.findingId}><span>{finding.severity}</span><strong>{statusLabel(finding.reasonCode)}</strong><small>{finding.affectedAxis ? statusLabel(finding.affectedAxis) : "Cross-axis"} · owner {finding.ownerRef}</small></li>)}</ol>}
        </section>

        <form className={styles.filters} method="get" aria-label="Filter harness status">
          <label><span>Aggregate state</span><select defaultValue={filters.state} name="state"><option value="ALL">All states</option>{AGGREGATE_STATES.map((state) => <option key={state}>{state}</option>)}</select></label>
          <label><span>Evidence axis</span><select defaultValue={filters.axis} name="axis"><option value="ALL">All axes</option>{EVIDENCE_AXES.map((axis) => <option key={axis}>{axis}</option>)}</select></label>
          <label><span>Selection</span><select defaultValue={filters.selection} name="selection"><option value="ALL">All selections</option>{SELECTION_STATES.map((selection) => <option key={selection}>{selection}</option>)}</select></label>
          <button type="submit">Apply filters</button><a href={operatorScope ? `/organizations/${overview.spec.organizationId}` : "/overview"}>Clear</a>
          <p aria-live="polite">Showing {visible.length} of 16 harnesses{selectedAxis ? `; evidence axis ${statusLabel(selectedAxis)}` : ""}.</p>
        </form>

        <div className={styles.systemGrid}>
          <HarnessOnion summaries={overview.spec.harnesses} visibleIds={visibleIds} />
          <section className={styles.semanticPanel} aria-labelledby="semantic-title">
            <div className={styles.mapHeading}><div><p className={styles.eyebrow}>Accessible equivalent</p><h2 id="semantic-title">Planes and harnesses</h2></div><p>Unselected harnesses are explanatory—not unhealthy.</p></div>
            <div className={styles.planeList}>{PLANES.map((plane) => {
              const planeSummary = overview.spec.planes.find((item) => item.planeId === plane.id);
              const planeHarnesses = visible.filter((item) => item.planeId === plane.id);
              return <section key={plane.id} aria-labelledby={`plane-${plane.id}`}><header><div><span>Plane {plane.number}</span><h3 id={`plane-${plane.id}`}><a href={`/planes/${plane.id}`}>{plane.name}</a></h3></div><strong data-state={planeSummary?.aggregateState ?? "EMPTY"}>{statusLabel(planeSummary?.aggregateState ?? "EMPTY")}</strong></header>{planeHarnesses.length === 0 ? <p className={styles.noMatches}>No harness in this plane matches the filters.</p> : <ul>{planeHarnesses.map((summary) => {
                const definition = HARNESSES.find((item) => item.id === summary.harnessId)!;
                const axisState = selectedAxis ? harnesses.find((projection) => projection.spec.harnessId === summary.harnessId)?.spec.axes.find((axis) => axis.axis === selectedAxis)?.state : null;
                return <li key={summary.harnessId}><a href={`/harnesses/${summary.harnessId}`}><span className={styles.harnessNumber}>{definition.number}</span><span><b>{definition.name}</b><small>{statusLabel(summary.selectionState)} · {statusLabel(summary.installationState)} · {summary.blockerCount} blocker{summary.blockerCount === 1 ? "" : "s"}{axisState ? ` · ${statusLabel(selectedAxis!)} ${statusLabel(axisState)}` : ""}</small></span><strong data-state={summary.aggregateState}>{statusLabel(summary.aggregateState)}</strong></a></li>;
              })}</ul>}</section>;
            })}</div>
          </section>
        </div>

        <section className={styles.axisSection} aria-labelledby="axis-title">
          <div><p className={styles.eyebrow}>Evidence is plural</p><h2 id="axis-title">Eleven independent proof axes</h2><p>Readiness does not collapse source, CI, release, deployment, runtime, security, assurance, or tenant acceptance into one score.</p></div>
          <ol>{EVIDENCE_AXES.map((axis, index) => <li data-selected={axis === selectedAxis} key={axis}><span>{String(index + 1).padStart(2, "0")}</span><strong>{statusLabel(axis)}</strong></li>)}</ol>
        </section>
      </main>
    </div>
  );
}

function EmptyOverview({ overview }: { readonly overview: TenantHarnessOverview }) {
  return <div className={styles.shell}><header className={styles.topbar}><a className={styles.brand} href="/overview">Planeon <span>Harness control</span></a></header><main className={styles.empty} id="main-content" tabIndex={-1}><p className={styles.eyebrow}>Organization · {overview.spec.organizationId}</p><h1>No harness demand exists yet.</h1><p>Start with business context and data readiness. Proposed prerequisites remain separate from installed harnesses.</p><a className={styles.primaryLink} href="/questionnaires">Begin guided setup</a></main></div>;
}
