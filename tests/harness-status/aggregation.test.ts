import { describe, expect, it } from "vitest";

import { ControlError } from "../../apps/control-web/src/lib/foundation/contracts";
import { deriveFreshness, deriveHarnessAggregate, validateBinding, validateOverview } from "../../apps/control-web/src/lib/harness-status/aggregation";
import { EVIDENCE_AXES, PROJECTION_SCHEMA_VERSION, type StatusAxisProjection } from "../../apps/control-web/src/lib/harness-status/contracts";
import { createFixtureProjectionSet, FIXTURE_NOW_EPOCH } from "../../apps/control-web/src/lib/harness-status/fixtures";

const passingAxes: readonly StatusAxisProjection[] = EVIDENCE_AXES.map((axis) => ({
  axis,
  required: true,
  state: "PASS",
  underlyingState: null,
  observedAt: "2026-09-03T00:00:00Z",
  evidenceRefs: [],
  waiver: null,
  applicability: null,
}));
const current = { state: "CURRENT" as const, projectedAt: "2026-09-03T00:00:00Z", freshUntil: "2026-09-03T02:00:00Z", sourceCursors: [] };

describe("closed status aggregation", () => {
  it("validates the complete fixture and derives plane and organization precedence", () => {
    const projections = createFixtureProjectionSet();
    expect(() => validateOverview(projections.overview, projections.harnesses, FIXTURE_NOW_EPOCH)).not.toThrow();
    expect(projections.overview.spec.aggregateState).toBe("BLOCKED");
    expect(projections.overview.spec.planes.map((plane) => plane.aggregateState)).toEqual(["READY", "BLOCKED", "EMPTY", "READY"]);
  });

  it("excludes NOT_SELECTED and PROPOSED harnesses from health", () => {
    expect(deriveHarnessAggregate("NOT_SELECTED", "FAILED", passingAxes, current)).toBe("EMPTY");
    expect(deriveHarnessAggregate("PROPOSED", "REVOKED", passingAxes, current)).toBe("EMPTY");
  });

  it("keeps failure, missing evidence, source loss, and waiver semantics distinct", () => {
    const withAxis = (index: number, state: StatusAxisProjection["state"], underlyingState: StatusAxisProjection["underlyingState"] = null) => passingAxes.map((axis, axisIndex) => axisIndex === index ? { ...axis, state, underlyingState, waiver: state === "WAIVED" ? { waiverId: "waiver.test", waiverDigest: `sha256:${"a".repeat(64)}`, approvedBy: "board.test", expiresAt: "2026-09-04T00:00:00Z", basisCode: "TEST_WAIVER" } : null } : axis);
    expect(deriveHarnessAggregate("SELECTED", "READY", withAxis(0, "FAIL"), current)).toBe("FAILED");
    expect(deriveHarnessAggregate("SELECTED", "READY", withAxis(0, "MISSING"), current)).toBe("BLOCKED");
    expect(deriveHarnessAggregate("SELECTED", "READY", passingAxes, { ...current, state: "SOURCE_UNAVAILABLE" })).toBe("BLOCKED");
    expect(deriveHarnessAggregate("SELECTED", "READY", withAxis(0, "WAIVED", "WARN"), current)).toBe("DEGRADED");
  });

  it("rejects missing, mutable, and expired binding authority", () => {
    const binding = createFixtureProjectionSet().overview.binding!;
    expect(deriveFreshness(binding, Date.parse("2026-09-03T01:30:00Z") / 1000).state).toBe("STALE");
    expect(() => validateBinding({ ...binding, projectionSchemaVersion: "changed" as typeof PROJECTION_SCHEMA_VERSION })).toThrowError(ControlError);
    expect(() => validateBinding({ ...binding, sourceCursors: [...binding.sourceCursors].reverse() })).toThrowError("STATUS_CURSOR_ORDER_INVALID");
  });
});
