import { ControlError } from "../foundation/contracts";
import {
  AGGREGATE_STATES,
  EVIDENCE_AXES,
  type AggregateState,
  type EvidenceState,
  type HarnessStatusProjection,
  type HarnessSummary,
  type InstallationState,
  type PlaneId,
  type PlaneSummary,
  type ProjectionBinding,
  type ProjectionFreshness,
  type SelectionState,
  type StatusAxisProjection,
  type TenantHarnessOverview,
} from "./contracts";
import { HARNESS_IDS, HARNESSES, PLANES } from "./taxonomy";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/u;
const AGGREGATE_RANK = new Map<AggregateState, number>(AGGREGATE_STATES.map((state, index) => [state, index]));
const INSTALLATION_RANK = new Map<InstallationState, number>([
  "REVOKED", "FAILED", "BLOCKED", "DEGRADED", "ROLLING_BACK", "UNINSTALLING",
  "UPGRADING", "HEALTH_CHECKING", "APPLYING", "VERIFYING", "PREFLIGHT", "PENDING",
  "READY", "RETIRED", "REMOVED", "ABSENT",
].map((state, index) => [state as InstallationState, index]));
const EVIDENCE_RANK = new Map<EvidenceState, number>([
  "FAIL", "STALE", "NOT_RUN_ENV_UNAVAILABLE", "MISSING", "COLLECTING", "WAIVED",
  "WARN", "PASS", "NOT_APPLICABLE",
].map((state, index) => [state as EvidenceState, index]));

function fail(code: string): never {
  throw new ControlError(code, 422);
}

function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value) && Number.isFinite(Date.parse(value));
}

export function validateBinding(binding: ProjectionBinding): void {
  if (!STABLE_ID.test(binding.organizationId)) fail("STATUS_ORGANIZATION_INVALID");
  for (const digest of [binding.profileDigest, binding.bundleDigest, binding.releaseDigest]) {
    if (!DIGEST.test(digest)) fail("STATUS_BINDING_DIGEST_INVALID");
  }
  if (!Number.isSafeInteger(binding.observedGeneration) || binding.observedGeneration < 1) fail("STATUS_GENERATION_INVALID");
  if (!validTimestamp(binding.projectedAt) || !validTimestamp(binding.freshUntil) || Date.parse(binding.projectedAt) >= Date.parse(binding.freshUntil)) fail("STATUS_FRESHNESS_WINDOW_INVALID");
  if (binding.projectionSchemaVersion !== "harness.planeon.ai/status-projection/v1alpha1") fail("STATUS_SCHEMA_VERSION_INVALID");
  if (binding.sourceCursors.length < 1) fail("STATUS_CURSOR_MISSING");
  const sorted = [...binding.sourceCursors].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  if (new Set(sorted.map((item) => item.sourceId)).size !== sorted.length || sorted.some((item, index) => item.sourceId !== binding.sourceCursors[index]?.sourceId)) fail("STATUS_CURSOR_ORDER_INVALID");
  for (const cursor of binding.sourceCursors) {
    if (!STABLE_ID.test(cursor.sourceId) || !/^[A-Za-z0-9._:-]{1,256}$/u.test(cursor.cursor) || !validTimestamp(cursor.observedAt)) fail("STATUS_CURSOR_INVALID");
  }
}

export function deriveFreshness(binding: ProjectionBinding, nowEpoch: number): ProjectionFreshness {
  validateBinding(binding);
  const sourceUnavailable = binding.sourceCursors.some((cursor) => cursor.state === "SOURCE_UNAVAILABLE");
  return Object.freeze({
    state: sourceUnavailable ? "SOURCE_UNAVAILABLE" : Date.parse(binding.freshUntil) <= nowEpoch * 1000 ? "STALE" : "CURRENT",
    projectedAt: binding.projectedAt,
    freshUntil: binding.freshUntil,
    sourceCursors: binding.sourceCursors,
  });
}

export function deriveHarnessAggregate(
  selection: SelectionState,
  installation: InstallationState,
  axes: readonly StatusAxisProjection[],
  freshness: ProjectionFreshness,
): AggregateState {
  if (selection === "NOT_SELECTED" || selection === "PROPOSED") return "EMPTY";
  if (installation === "REVOKED") return "REVOKED";
  if (installation === "FAILED" || axes.some((axis) => axis.required && axis.state === "FAIL")) return "FAILED";
  const blockedAxis = new Set<EvidenceState>(["MISSING", "STALE", "NOT_RUN_ENV_UNAVAILABLE"]);
  if (selection === "BLOCKED" || installation === "BLOCKED" || freshness.state !== "CURRENT" || axes.some((axis) => axis.required && blockedAxis.has(axis.state))) return "BLOCKED";
  if (installation === "DEGRADED" || axes.some((axis) => axis.state === "WARN" || axis.state === "WAIVED")) return "DEGRADED";
  const requiredReady = axes.filter((axis) => axis.required).every((axis) => axis.state === "PASS" || axis.state === "NOT_APPLICABLE");
  return installation === "READY" && requiredReady ? "READY" : "BLOCKED";
}

export function highestEvidenceState(axes: readonly StatusAxisProjection[]): EvidenceState {
  return [...axes].sort((left, right) => (EVIDENCE_RANK.get(left.state) ?? 99) - (EVIDENCE_RANK.get(right.state) ?? 99))[0]?.state ?? "MISSING";
}

export function harnessSummary(projection: HarnessStatusProjection): HarnessSummary {
  const { spec } = projection;
  return Object.freeze({
    harnessId: spec.harnessId,
    planeId: spec.planeId,
    selectionState: spec.selectionState,
    installationState: spec.installationState,
    aggregateState: deriveHarnessAggregate(spec.selectionState, spec.installationState, spec.axes, spec.freshness),
    highestEvidenceState: highestEvidenceState(spec.axes),
    freshnessState: spec.freshness.state,
    blockerCount: spec.findings.filter((finding) => finding.blocking).length + spec.dependencies.filter((dependency) => dependency.blocking).length,
    reasonCode: spec.reasonCode,
  });
}

function worstAggregate(states: readonly AggregateState[]): AggregateState {
  return [...states].sort((left, right) => (AGGREGATE_RANK.get(right) ?? -1) - (AGGREGATE_RANK.get(left) ?? -1))[0] ?? "EMPTY";
}

export function planeSummary(planeId: PlaneId, summaries: readonly HarnessSummary[]): PlaneSummary {
  const selected = summaries.filter((item) => item.selectionState === "SELECTED" || item.selectionState === "BLOCKED");
  const freshness = summaries.some((item) => item.freshnessState === "SOURCE_UNAVAILABLE")
    ? "SOURCE_UNAVAILABLE"
    : summaries.some((item) => item.freshnessState === "STALE") ? "STALE" : "CURRENT";
  const worstInstallationState = selected.length === 0 ? null : [...selected]
    .sort((left, right) => (INSTALLATION_RANK.get(left.installationState) ?? 99) - (INSTALLATION_RANK.get(right.installationState) ?? 99))[0]?.installationState ?? null;
  return Object.freeze({
    planeId,
    aggregateState: worstAggregate(selected.map((item) => item.aggregateState)),
    selectedCount: selected.length,
    notSelectedCount: summaries.filter((item) => item.selectionState === "NOT_SELECTED").length,
    worstInstallationState,
    freshnessState: freshness,
    blockingDependencyCount: summaries.reduce((total, item) => total + item.blockerCount, 0),
    harnesses: summaries,
  });
}

export function validateOverview(
  overview: TenantHarnessOverview,
  harnesses: readonly HarnessStatusProjection[],
  nowEpoch: number,
): void {
  if (overview.apiVersion !== "harness.planeon.ai/v1alpha1" || overview.kind !== "TenantHarnessOverview") fail("STATUS_KIND_INVALID");
  if (overview.spec.empty) {
    if (overview.binding !== null || overview.spec.aggregateState !== "EMPTY" || overview.spec.freshness !== null || overview.spec.planes.length !== 0 || overview.spec.harnesses.length !== 0) fail("STATUS_EMPTY_INVALID");
    return;
  }
  if (!overview.binding) fail("STATUS_BINDING_MISSING");
  validateBinding(overview.binding);
  if (overview.binding.organizationId !== overview.spec.organizationId) fail("STATUS_ORGANIZATION_MISMATCH");
  if (harnesses.length !== 16 || overview.spec.harnesses.length !== 16 || overview.spec.planes.length !== 4) fail("STATUS_TAXONOMY_INCOMPLETE");
  if (harnesses.some((item, index) => item.spec.harnessId !== HARNESS_IDS[index])) fail("STATUS_TAXONOMY_ORDER_INVALID");
  if (overview.spec.planes.some((item, index) => item.planeId !== PLANES[index]?.id || item.harnesses.length !== 4)) fail("STATUS_PLANE_ORDER_INVALID");
  for (const harness of harnesses) {
    const definition = HARNESSES.find((item) => item.id === harness.spec.harnessId);
    if (!definition || definition.planeId !== harness.spec.planeId) fail("STATUS_HARNESS_INVALID");
    if (harness.binding.organizationId !== overview.binding.organizationId || harness.binding.profileDigest !== overview.binding.profileDigest || harness.binding.bundleDigest !== overview.binding.bundleDigest || harness.binding.releaseDigest !== overview.binding.releaseDigest || harness.binding.observedGeneration !== overview.binding.observedGeneration) fail("STATUS_BINDING_MISMATCH");
    if (harness.spec.axes.length !== EVIDENCE_AXES.length || harness.spec.axes.some((axis, index) => axis.axis !== EVIDENCE_AXES[index])) fail("STATUS_AXIS_ORDER_INVALID");
    for (const axis of harness.spec.axes) {
      if (axis.state === "WAIVED" && (!axis.waiver || axis.underlyingState === null || axis.underlyingState === "PASS" || axis.underlyingState === "NOT_APPLICABLE")) fail("STATUS_WAIVER_INVALID");
      if (axis.state !== "WAIVED" && (axis.waiver !== null || axis.underlyingState !== null)) fail("STATUS_WAIVER_INVALID");
    }
    const expected = harnessSummary(harness);
    if (harness.spec.aggregateState !== expected.aggregateState || harness.spec.freshness.state !== deriveFreshness(harness.binding, nowEpoch).state) fail("STATUS_HARNESS_DERIVATION_INVALID");
    const summary = overview.spec.harnesses.find((item) => item.harnessId === harness.spec.harnessId);
    if (!summary || JSON.stringify(expected) !== JSON.stringify(summary)) fail("STATUS_SUMMARY_DERIVATION_INVALID");
  }
  const expectedFreshness = deriveFreshness(overview.binding, nowEpoch);
  if (!overview.spec.freshness || overview.spec.freshness.state !== expectedFreshness.state) fail("STATUS_FRESHNESS_INVALID");
  const expectedPlanes = PLANES.map((plane) => planeSummary(plane.id, overview.spec.harnesses.filter((item) => item.planeId === plane.id)));
  if (JSON.stringify(expectedPlanes) !== JSON.stringify(overview.spec.planes)) fail("STATUS_PLANE_DERIVATION_INVALID");
  if (overview.spec.aggregateState !== worstAggregate(expectedPlanes.map((plane) => plane.aggregateState))) fail("STATUS_AGGREGATE_INVALID");
  const expectedFindings = harnesses.flatMap((harness) => harness.spec.findings).sort((left, right) => left.findingId.localeCompare(right.findingId));
  if (JSON.stringify(expectedFindings) !== JSON.stringify(overview.spec.priorityFindings)) fail("STATUS_FINDING_DERIVATION_INVALID");
}
