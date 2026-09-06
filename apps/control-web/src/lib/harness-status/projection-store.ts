import { canonicalJson, sha256 } from "../foundation/canonical";
import { ControlError, type TenantContext } from "../foundation/contracts";
import {
  AGGREGATE_STATES,
  SOURCE_IDS,
  type AggregateState,
  type HarnessStatusProjection,
  type OrganizationPortfolioPage,
  type PlaneId,
  type PlaneStatusProjection,
  type ProjectionBinding,
  type ProjectionFreshness,
  type SourceId,
  type SourceSummary,
  type TenantHarnessOverview,
  sourceCursorId,
} from "./contracts";
import { deriveFreshness, deriveHarnessAggregate, harnessSummary, planeSummary, validateOverview } from "./aggregation";

interface CursorRecord {
  readonly sequence: number;
  readonly cursor: string;
  readonly eventId: string;
  readonly contentDigest: string;
  readonly observedAt: string;
}

interface ProjectionRecord {
  readonly overview: TenantHarnessOverview;
  readonly planes: readonly PlaneStatusProjection[];
  readonly harnesses: readonly HarnessStatusProjection[];
}

export interface SourceAdmissionPolicy {
  authorize(summary: SourceSummary): boolean;
}

export class DenySourceAdmissionPolicy implements SourceAdmissionPolicy {
  authorize(): boolean { return false; }
}

export interface OperatorAuditRecord {
  readonly sequence: number;
  readonly eventId: string;
  readonly subjectDigest: string;
  readonly action: "organization:portfolio:view";
  readonly target: string;
  readonly decision: "ALLOW" | "DENY";
  readonly policyDigest: string;
  readonly occurredAt: string;
}

export interface OperatorDecision {
  readonly allowed: boolean;
  readonly policyDigest: string;
}

export interface OperatorPolicy {
  authorize(subjectDigest: string, action: "organization:portfolio:view", target: string): OperatorDecision;
}

export class DenyOperatorPolicy implements OperatorPolicy {
  authorize(): OperatorDecision {
    return { allowed: false, policyDigest: `sha256:${"0".repeat(64)}` };
  }
}

function assertDigest(value: string, code: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new ControlError(code, 422);
}

function expectedSourceDigest(summary: SourceSummary): string {
  return sha256(canonicalJson({
    sourceId: summary.sourceId,
    sourcePrincipalDigest: summary.sourcePrincipalDigest,
    sourceAdmissionDigest: summary.sourceAdmissionDigest,
    sequence: summary.sequence,
    eventId: summary.eventId,
    organizationId: summary.organizationId,
    releaseDigest: summary.releaseDigest,
    overview: summary.overview,
    planes: summary.planes,
    harnesses: summary.harnesses,
  }));
}

function bindingMatches(summary: SourceSummary): boolean {
  const binding = summary.overview.binding;
  return binding !== null
    && binding.organizationId === summary.organizationId
    && binding.profileDigest === summary.profileDigest
    && binding.bundleDigest === summary.bundleDigest
    && binding.releaseDigest === summary.releaseDigest
    && binding.observedGeneration === summary.observedGeneration;
}

function freezeSnapshot<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

function withFreshness(state: AggregateState, freshness: ProjectionFreshness): AggregateState {
  return freshness.state !== "CURRENT" && (state === "READY" || state === "DEGRADED") ? "BLOCKED" : state;
}

export class ProjectionStore {
  private projections = new Map<string, ProjectionRecord>();
  private cursors = new Map<string, CursorRecord>();
  private events = new Map<string, string>();
  private unavailable = new Map<string, Set<SourceId>>();
  private operatorAuditLog: OperatorAuditRecord[] = [];
  private failAudit = false;

  constructor(private readonly sourceAdmission: SourceAdmissionPolicy = new DenySourceAdmissionPolicy()) {}

  failNextAudit(): void {
    this.failAudit = true;
  }

  ingest(summary: SourceSummary, nowEpoch: number): "APPLIED" | "REPLAYED" {
    if (!SOURCE_IDS.includes(summary.sourceId)) throw new ControlError("STATUS_SOURCE_INVALID", 422);
    assertDigest(summary.sourcePrincipalDigest, "STATUS_SOURCE_AUTHORITY_INVALID");
    assertDigest(summary.sourceAdmissionDigest, "STATUS_SOURCE_AUTHORITY_INVALID");
    if (!this.sourceAdmission.authorize(summary)) throw new ControlError("STATUS_SOURCE_AUTHORITY_REFUSED", 403);
    if (!Number.isSafeInteger(summary.sequence) || summary.sequence < 1 || !/^[A-Za-z0-9._:-]{1,256}$/u.test(summary.cursor) || Date.parse(summary.observedAt) > nowEpoch * 1000) throw new ControlError("STATUS_SOURCE_ORDER_INVALID", 409);
    for (const digest of [summary.profileDigest, summary.bundleDigest, summary.releaseDigest, summary.contentDigest]) assertDigest(digest, "STATUS_SOURCE_BINDING_INVALID");
    if (summary.contentDigest !== expectedSourceDigest(summary) || !bindingMatches(summary)) throw new ControlError("STATUS_SOURCE_BINDING_INVALID", 422);
    validateOverview(summary.overview, summary.harnesses, nowEpoch);
    if (summary.planes.length !== 4 || summary.harnesses.some((harness) => !summary.planes.some((plane) => plane.spec.planeId === harness.spec.planeId))) throw new ControlError("STATUS_SOURCE_PROJECTION_INVALID", 422);
    for (const plane of summary.planes) {
      const expected = summary.overview.spec.planes.find((item) => item.planeId === plane.spec.planeId);
      const actual = {
        planeId: plane.spec.planeId,
        aggregateState: plane.spec.aggregateState,
        selectedCount: plane.spec.selectedCount,
        notSelectedCount: plane.spec.notSelectedCount,
        worstInstallationState: plane.spec.worstInstallationState,
        freshnessState: plane.spec.freshnessState,
        blockingDependencyCount: plane.spec.blockingDependencyCount,
        harnesses: plane.spec.harnesses,
      };
      if (plane.apiVersion !== "harness.planeon.ai/v1alpha1" || plane.kind !== "PlaneStatusProjection" || plane.binding.organizationId !== summary.organizationId || JSON.stringify(actual) !== JSON.stringify(expected)) throw new ControlError("STATUS_SOURCE_PROJECTION_INVALID", 422);
    }

    const priorEvent = this.events.get(summary.eventId);
    if (priorEvent !== undefined) {
      if (priorEvent !== summary.contentDigest) throw new ControlError("STATUS_EVENT_CONFLICT", 409);
      return "REPLAYED";
    }
    const cursorKey = `${summary.organizationId}:${summary.sourceId}`;
    const priorCursor = this.cursors.get(cursorKey);
    if (summary.sequence !== (priorCursor?.sequence ?? 0) + 1 || (priorCursor && summary.cursor <= priorCursor.cursor)) throw new ControlError("STATUS_CURSOR_GAP", 409);
    const priorProjection = this.projections.get(summary.organizationId);
    if (priorProjection?.overview.binding && summary.overview.binding && (
      priorProjection.overview.binding.profileDigest !== summary.profileDigest
      || priorProjection.overview.binding.bundleDigest !== summary.bundleDigest
      || priorProjection.overview.binding.releaseDigest !== summary.releaseDigest
      || priorProjection.overview.binding.observedGeneration !== summary.observedGeneration
    )) throw new ControlError("STATUS_PROJECTION_BINDING_CONFLICT", 409);

    // Take custody of values, not caller aliases. Read-time derivation never
    // changes these admitted facts, including nested cursors and evidence refs.
    const nextRecord = freezeSnapshot(structuredClone({ overview: summary.overview, planes: summary.planes, harnesses: summary.harnesses }));
    const nextCursor = Object.freeze({ sequence: summary.sequence, cursor: summary.cursor, eventId: summary.eventId, contentDigest: summary.contentDigest, observedAt: summary.observedAt });
    this.projections.set(summary.organizationId, nextRecord);
    this.cursors.set(cursorKey, nextCursor);
    this.events.set(summary.eventId, summary.contentDigest);
    this.unavailable.get(summary.organizationId)?.delete(summary.sourceId);
    return "APPLIED";
  }

  markSourceUnavailable(organizationId: string, sourceId: SourceId): void {
    if (!this.projections.has(organizationId) || !SOURCE_IDS.includes(sourceId)) throw new ControlError("STATUS_PROJECTION_NOT_FOUND", 404);
    const unavailable = new Set(this.unavailable.get(organizationId) ?? []);
    unavailable.add(sourceId);
    this.unavailable.set(organizationId, unavailable);
  }

  readOverview(context: TenantContext, nowEpoch = Date.now() / 1000): TenantHarnessOverview {
    return this.readOrganization(context.organizationId, nowEpoch);
  }

  readPlane(context: TenantContext, planeId: PlaneId, nowEpoch = Date.now() / 1000): PlaneStatusProjection {
    return this.materialize(context.organizationId, nowEpoch).planes.find((plane) => plane.spec.planeId === planeId) ?? this.notFound();
  }

  readHarness(context: TenantContext, harnessId: string, nowEpoch = Date.now() / 1000): HarnessStatusProjection {
    return this.materialize(context.organizationId, nowEpoch).harnesses.find((harness) => harness.spec.harnessId === harnessId) ?? this.notFound();
  }

  readOrganization(organizationId: string, nowEpoch = Date.now() / 1000): TenantHarnessOverview {
    return this.materialize(organizationId, nowEpoch).overview;
  }

  organizationIds(): readonly string[] {
    return [...this.projections.keys()].sort();
  }

  portfolio(limit: number, cursor: string | null, state: AggregateState | null, nowEpoch = Date.now() / 1000): OrganizationPortfolioPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (state !== null && !AGGREGATE_STATES.includes(state))) throw new ControlError("STATUS_QUERY_REFUSED", 400);
    const records = this.organizationIds().map((id) => this.materialize(id, nowEpoch).overview).filter((overview) => overview.binding !== null && (state === null || overview.spec.aggregateState === state))
      .sort((left, right) => left.spec.displayName.localeCompare(right.spec.displayName) || left.spec.organizationId.localeCompare(right.spec.organizationId));
    const cursorFor = (overview: TenantHarnessOverview) => sha256(canonicalJson({ organizationId: overview.spec.organizationId, displayName: overview.spec.displayName }));
    const start = cursor === null ? 0 : records.findIndex((overview) => cursorFor(overview) === cursor) + 1;
    if (cursor !== null && start === 0) throw new ControlError("STATUS_CURSOR_REFUSED", 400);
    const page = records.slice(start, start + limit);
    const last = page.at(-1);
    return Object.freeze({
      apiVersion: "harness.planeon.ai/v1alpha1",
      kind: "OrganizationHarnessPortfolioPage",
      spec: Object.freeze({
        scope: "PLATFORM_OPERATOR",
        projectionSchemaVersion: "harness.planeon.ai/status-projection/v1alpha1",
        limit,
        nextCursor: start + page.length < records.length && last ? cursorFor(last) : null,
        items: Object.freeze(page.map((overview) => Object.freeze({
          binding: overview.binding!,
          displayName: overview.spec.displayName,
          deploymentMode: overview.spec.deploymentMode,
          aggregateState: overview.spec.aggregateState,
          freshnessState: overview.spec.freshness?.state ?? "STALE",
          selectedCount: overview.spec.harnesses.filter((harness) => harness.selectionState === "SELECTED" || harness.selectionState === "BLOCKED").length,
          blockerCount: overview.spec.harnesses.reduce((total, harness) => total + harness.blockerCount, 0),
        }))),
      }),
    });
  }

  appendOperatorAudit(input: Omit<OperatorAuditRecord, "sequence" | "eventId">): OperatorAuditRecord {
    if (this.failAudit) {
      this.failAudit = false;
      throw new ControlError("STATUS_OPERATOR_AUDIT_FAILED", 503);
    }
    assertDigest(input.subjectDigest, "STATUS_OPERATOR_AUDIT_INVALID");
    assertDigest(input.policyDigest, "STATUS_OPERATOR_AUDIT_INVALID");
    const record = Object.freeze({
      ...input,
      sequence: this.operatorAuditLog.length + 1,
      eventId: `operator-audit.${this.operatorAuditLog.length + 1}.${sha256(canonicalJson(input)).slice(7, 23)}`,
    });
    this.operatorAuditLog.push(record);
    return record;
  }

  operatorAudit(): readonly Readonly<OperatorAuditRecord>[] {
    return [...this.operatorAuditLog];
  }

  cursor(organizationId: string, sourceId: SourceId): Readonly<CursorRecord> | undefined {
    return this.cursors.get(`${organizationId}:${sourceId}`);
  }

  private materialize(organizationId: string, nowEpoch: number): ProjectionRecord {
    if (!Number.isFinite(nowEpoch)) throw new ControlError("STATUS_CLOCK_INVALID", 422);
    const record = this.projections.get(organizationId);
    if (!record) return this.notFound();
    const unavailable = this.unavailable.get(organizationId);
    if (!record.overview.binding) return record;
    const unavailableCursorIds = new Set([...(unavailable ?? [])].map(sourceCursorId));
    const materializedBinding = (admitted: ProjectionBinding): ProjectionBinding => unavailableCursorIds.size === 0 ? admitted : freezeSnapshot({
      ...admitted,
      sourceCursors: admitted.sourceCursors.map((cursor) => unavailableCursorIds.has(cursor.sourceId) ? { ...cursor, state: "SOURCE_UNAVAILABLE" as const } : cursor),
    });
    const materializedFreshness = (binding: ProjectionBinding): ProjectionFreshness => {
      const derived = deriveFreshness(binding, nowEpoch);
      // An explicitly unavailable organization source is never hidden by expiry
      // or by a snapshot that does not yet contain that source's cursor.
      return unavailableCursorIds.size === 0 ? derived : Object.freeze({ ...derived, state: "SOURCE_UNAVAILABLE" });
    };
    const binding = materializedBinding(record.overview.binding);
    const freshness = materializedFreshness(binding);
    const harnesses = record.harnesses.map((harness) => {
      const binding = materializedBinding(harness.binding);
      const freshness = materializedFreshness(binding);
      return Object.freeze({ ...harness, binding, spec: Object.freeze({ ...harness.spec, freshness,
        aggregateState: deriveHarnessAggregate(harness.spec.selectionState, harness.spec.installationState, harness.spec.axes, freshness),
      }) });
    });
    const summaries = harnesses.map(harnessSummary);
    const planeSummaries = record.planes.map((plane) => {
      const summary = planeSummary(plane.spec.planeId, summaries.filter((item) => item.planeId === plane.spec.planeId));
      const freshness = materializedFreshness(materializedBinding(plane.binding));
      return Object.freeze({ ...summary, aggregateState: withFreshness(summary.aggregateState, freshness),
        freshnessState: summary.freshnessState === "SOURCE_UNAVAILABLE" || freshness.state === "SOURCE_UNAVAILABLE" ? "SOURCE_UNAVAILABLE" as const
          : summary.freshnessState === "STALE" || freshness.state === "STALE" ? "STALE" as const : "CURRENT" as const });
    });
    const planes = record.planes.map((plane, index) => {
      const binding = materializedBinding(plane.binding);
      return Object.freeze({ ...plane, binding, spec: Object.freeze({ ...plane.spec, ...planeSummaries[index]!, freshness: materializedFreshness(binding) }) });
    });
    const rank: Record<AggregateState, number> = { EMPTY: 0, READY: 1, DEGRADED: 2, BLOCKED: 3, FAILED: 4, REVOKED: 5 };
    const aggregateState = planes.reduce<AggregateState>((worst, plane) => rank[plane.spec.aggregateState] > rank[worst] ? plane.spec.aggregateState : worst, "EMPTY");
    const overview = Object.freeze({
      ...record.overview,
      binding,
      spec: Object.freeze({ ...record.overview.spec, freshness, aggregateState: withFreshness(aggregateState, freshness),
        stateCounts: Object.freeze(record.overview.spec.stateCounts.map((row) => Object.freeze({ ...row, count: summaries.filter((harness) => harness.aggregateState === row.state).length }))),
        planes: Object.freeze(planeSummaries), harnesses: Object.freeze(summaries) }),
    });
    return Object.freeze({ overview, planes: Object.freeze(planes), harnesses: Object.freeze(harnesses) });
  }

  private notFound(): never {
    throw new ControlError("STATUS_PROJECTION_NOT_FOUND", 404);
  }
}
