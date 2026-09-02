import { canonicalJson, sha256 } from "../foundation/canonical";
import {
  EVIDENCE_AXES,
  PROJECTION_SCHEMA_VERSION,
  SOURCE_IDS,
  STATUS_API_VERSION,
  type AggregateState,
  type EvidenceAxis,
  type EvidenceState,
  type HarnessStatusProjection,
  type InstallationState,
  type PlaneStatusProjection,
  type ProjectionBinding,
  type ProjectionFreshness,
  type SelectionState,
  type SourceSummary,
  type StatusAxisProjection,
  type StatusFindingSummary,
  type TenantHarnessOverview,
  sourceCursorId,
} from "./contracts";
import { deriveFreshness, harnessSummary, planeSummary } from "./aggregation";
import { HARNESSES, PLANES } from "./taxonomy";

export const FIXTURE_NOW_EPOCH = Date.parse("2026-09-03T01:00:00Z") / 1000;
export const FIXTURE_ORGANIZATION_ID = "org.marmara-thermal";
const PROFILE_DIGEST = `sha256:${"1".repeat(64)}`;
const BUNDLE_DIGEST = `sha256:${"2".repeat(64)}`;
const RELEASE_DIGEST = `sha256:${"3".repeat(64)}`;

function binding(organizationId = FIXTURE_ORGANIZATION_ID): ProjectionBinding {
  const sourceCursors = SOURCE_IDS.map((sourceId, index) => ({
    sourceId: sourceCursorId(sourceId),
    cursor: `cursor.${String(index + 1).padStart(2, "0")}`,
    observedAt: "2026-09-03T00:55:00Z",
    state: "CURRENT" as const,
  })).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  return Object.freeze({
    organizationId,
    profileDigest: PROFILE_DIGEST,
    bundleDigest: BUNDLE_DIGEST,
    releaseDigest: RELEASE_DIGEST,
    observedGeneration: 7,
    projectedAt: "2026-09-03T00:56:00Z",
    freshUntil: "2026-09-03T01:26:00Z",
    sourceCursors: Object.freeze(sourceCursors),
    projectionSchemaVersion: PROJECTION_SCHEMA_VERSION,
  });
}

function applicability(axis: EvidenceAxis) {
  return {
    reasonCode: `${axis}_NOT_REQUIRED`,
    contractRef: {
      apiVersion: "harness.planeon.ai/v1alpha1",
      kind: "ApplicabilityContract",
      id: `applicability.${axis.toLowerCase()}`,
      digest: `sha256:${"a".repeat(64)}`,
    },
  } as const;
}

function axes(
  selection: SelectionState,
  overrides: Readonly<Partial<Record<EvidenceAxis, EvidenceState>>> = {},
): readonly StatusAxisProjection[] {
  return Object.freeze(EVIDENCE_AXES.map((axis) => {
    const required = selection === "SELECTED" && !["ASSURANCE", "TENANT_ACCEPTANCE"].includes(axis);
    const state = overrides[axis] ?? (selection === "SELECTED" ? required ? "PASS" : "NOT_APPLICABLE" : "NOT_APPLICABLE");
    const waived = state === "WAIVED";
    return Object.freeze({
      axis,
      required,
      state,
      underlyingState: waived ? "WARN" as const : null,
      observedAt: state === "NOT_APPLICABLE" ? null : "2026-09-03T00:54:00Z",
      evidenceRefs: state === "PASS" || state === "WARN" || state === "WAIVED" ? Object.freeze([{
        apiVersion: "harness.planeon.ai/v1alpha1",
        kind: "EvidenceRecord",
        id: `evidence.${axis.toLowerCase()}`,
        digest: sha256(axis),
      }]) : Object.freeze([]),
      waiver: waived ? Object.freeze({
        waiverId: "waiver.domain-security",
        waiverDigest: `sha256:${"b".repeat(64)}`,
        approvedBy: "governance.board-a",
        expiresAt: "2026-09-10T00:00:00Z",
        basisCode: "CONTROL_DEGRADED_ACCEPTED",
      }) : null,
      applicability: state === "NOT_APPLICABLE" ? applicability(axis) : null,
    });
  }));
}

function finding(harnessId: string): StatusFindingSummary {
  return Object.freeze({
    findingId: `finding.${harnessId}`,
    severity: "ERROR",
    reasonCode: "RUNTIME_EVIDENCE_MISSING",
    affectedAxis: "RUNTIME",
    ownerRef: "team.data-foundation",
    blocking: true,
    evidenceRefs: Object.freeze([]),
    permittedActions: Object.freeze(["REQUEST_EVIDENCE", "CONTACT_OWNER"] as const),
  });
}

function stateFor(id: string): { selection: SelectionState; installation: InstallationState; overrides?: Partial<Record<EvidenceAxis, EvidenceState>> } {
  if (id === "runtime.infrastructure" || id === "trust.security-safety" || id === "trust.observability-finops") return { selection: "SELECTED", installation: "READY" };
  if (id === "knowledge.domain-semantic") return { selection: "SELECTED", installation: "DEGRADED", overrides: { SECURITY: "WAIVED" } };
  if (id === "knowledge.data-integration") return { selection: "SELECTED", installation: "BLOCKED", overrides: { RUNTIME: "MISSING" } };
  return { selection: "NOT_SELECTED", installation: "ABSENT" };
}

export interface FixtureProjectionSet {
  readonly overview: TenantHarnessOverview;
  readonly planes: readonly PlaneStatusProjection[];
  readonly harnesses: readonly HarnessStatusProjection[];
}

export function createFixtureProjectionSet(
  organizationId = FIXTURE_ORGANIZATION_ID,
  displayName = "Marmara Thermal Systems",
): FixtureProjectionSet {
  const projectionBinding = binding(organizationId);
  const freshness = deriveFreshness(projectionBinding, FIXTURE_NOW_EPOCH);
  const harnesses = HARNESSES.map((definition) => {
    const state = stateFor(definition.id);
    const harnessAxes = axes(state.selection, state.overrides);
    const findings = definition.id === "knowledge.data-integration" ? Object.freeze([finding(definition.id)]) : Object.freeze([]);
    const aggregateState = state.selection === "NOT_SELECTED" ? "EMPTY"
      : state.installation === "BLOCKED" ? "BLOCKED"
      : state.installation === "DEGRADED" ? "DEGRADED" : "READY";
    return Object.freeze({
      apiVersion: STATUS_API_VERSION,
      kind: "HarnessStatusProjection" as const,
      binding: projectionBinding,
      spec: Object.freeze({
        harnessId: definition.id,
        planeId: definition.planeId,
        purposeCode: `PURPOSE_${definition.id.replaceAll(/[.-]/gu, "_").toUpperCase()}`,
        ownerRef: `repository.${definition.planeId}-plane`,
        selectionState: state.selection,
        installationState: state.installation,
        aggregateState: aggregateState as AggregateState,
        desiredGeneration: 7,
        observedGeneration: state.selection === "NOT_SELECTED" ? 0 : 7,
        currentReleaseDigest: state.selection === "NOT_SELECTED" ? null : RELEASE_DIGEST,
        lastGoodReleaseDigest: state.selection === "NOT_SELECTED" ? null : RELEASE_DIGEST,
        selectedModuleIds: state.selection === "NOT_SELECTED" ? Object.freeze([]) : Object.freeze([`module.${definition.id}.primary`]),
        selectedProviderIds: state.selection === "NOT_SELECTED" ? Object.freeze([]) : Object.freeze([`provider.${definition.id}.local`]),
        axes: harnessAxes,
        freshness,
        dependencies: Object.freeze([]),
        findings,
        reasonCode: state.selection === "NOT_SELECTED" ? "HARNESS_NOT_SELECTED" : definition.id === "knowledge.data-integration" ? "RUNTIME_EVIDENCE_MISSING" : state.installation === "DEGRADED" ? "WAIVER_ACTIVE" : "HARNESS_READY",
        permittedActions: Object.freeze(state.selection === "NOT_SELECTED" ? ["NONE"] as const : definition.id === "knowledge.data-integration" ? ["REQUEST_EVIDENCE", "CONTACT_OWNER"] as const : ["NONE"] as const),
      }),
    });
  });
  const summaries = harnesses.map(harnessSummary);
  const planeSummaries = PLANES.map((plane) => planeSummary(plane.id, summaries.filter((summary) => summary.planeId === plane.id)));
  const planes = planeSummaries.map((summary) => Object.freeze({
    apiVersion: STATUS_API_VERSION,
    kind: "PlaneStatusProjection" as const,
    binding: projectionBinding,
    spec: Object.freeze({
      ...summary,
      evidenceCounts: Object.freeze(EVIDENCE_STATES_FOR_COUNTS.map((state) => ({
        state,
        count: harnesses.filter((harness) => harness.spec.planeId === summary.planeId).flatMap((harness) => harness.spec.axes).filter((axis) => axis.state === state).length,
      }))),
      freshness,
      reasonCode: summary.aggregateState === "READY" ? "PLANE_READY" : summary.aggregateState === "EMPTY" ? "PLANE_NOT_SELECTED" : "PLANE_ATTENTION_REQUIRED",
    }),
  }));
  const aggregateState = planeSummaries.reduce<AggregateState>((worst, plane) => {
    const rank: Record<AggregateState, number> = { EMPTY: 0, READY: 1, DEGRADED: 2, BLOCKED: 3, FAILED: 4, REVOKED: 5 };
    return rank[plane.aggregateState] > rank[worst] ? plane.aggregateState : worst;
  }, "EMPTY");
  const overview = Object.freeze({
    apiVersion: STATUS_API_VERSION,
    kind: "TenantHarnessOverview" as const,
    binding: projectionBinding,
    spec: Object.freeze({
      organizationId,
      displayName,
      deploymentMode: "air-gapped" as const,
      isolationBoundary: "PHYSICAL_AIR_GAP" as const,
      empty: false,
      aggregateState,
      freshness,
      stateCounts: Object.freeze(["READY", "DEGRADED", "BLOCKED", "FAILED", "REVOKED", "EMPTY"].map((state) => ({ state, count: summaries.filter((summary) => summary.aggregateState === state).length }))),
      priorityFindings: Object.freeze(harnesses.flatMap((harness) => harness.spec.findings).sort((left, right) => left.findingId.localeCompare(right.findingId))),
      planes: Object.freeze(planeSummaries),
      harnesses: Object.freeze(summaries),
    }),
  });
  return Object.freeze({ overview, planes: Object.freeze(planes), harnesses: Object.freeze(harnesses) });
}

const EVIDENCE_STATES_FOR_COUNTS: readonly EvidenceState[] = ["NOT_APPLICABLE", "MISSING", "COLLECTING", "PASS", "WARN", "FAIL", "STALE", "WAIVED", "NOT_RUN_ENV_UNAVAILABLE"];

export function createEmptyOverview(organizationId = "org.empty-foundry"): TenantHarnessOverview {
  return Object.freeze({
    apiVersion: STATUS_API_VERSION,
    kind: "TenantHarnessOverview",
    binding: null,
    spec: Object.freeze({
      organizationId,
      displayName: "Empty Foundry Workspace",
      deploymentMode: "self-managed",
      isolationBoundary: "DEDICATED_NAMESPACE",
      empty: true,
      aggregateState: "EMPTY",
      freshness: null,
      stateCounts: Object.freeze([]),
      priorityFindings: Object.freeze([]),
      planes: Object.freeze([]),
      harnesses: Object.freeze([]),
    }),
  });
}

export function sourceSummary(
  sourceId: SourceSummary["sourceId"],
  sequence: number,
  projections = createFixtureProjectionSet(),
): SourceSummary {
  const organizationToken = sha256(projections.overview.spec.organizationId).slice(7, 19);
  const eventId = `event.${sourceId.toLowerCase()}.${organizationToken}.${sequence}`;
  const sourcePayload = {
    sourceId,
    sourcePrincipalDigest: `sha256:${"4".repeat(64)}`,
    sourceAdmissionDigest: `sha256:${"5".repeat(64)}`,
    sequence,
    eventId,
    organizationId: projections.overview.spec.organizationId,
    releaseDigest: projections.overview.binding?.releaseDigest,
    overview: projections.overview,
    planes: projections.planes,
    harnesses: projections.harnesses,
  };
  const contentDigest = sha256(canonicalJson(sourcePayload));
  return Object.freeze({
    sourceId,
    sourcePrincipalDigest: sourcePayload.sourcePrincipalDigest,
    sourceAdmissionDigest: sourcePayload.sourceAdmissionDigest,
    eventId,
    organizationId: projections.overview.spec.organizationId,
    sequence,
    cursor: `cursor.${sourceId.toLowerCase()}.${sequence}`,
    observedAt: "2026-09-03T00:55:00Z",
    profileDigest: projections.overview.binding?.profileDigest ?? "",
    bundleDigest: projections.overview.binding?.bundleDigest ?? "",
    releaseDigest: projections.overview.binding?.releaseDigest ?? "",
    observedGeneration: projections.overview.binding?.observedGeneration ?? 0,
    contentDigest,
    overview: projections.overview,
    planes: projections.planes,
    harnesses: projections.harnesses,
  });
}
