import { afterEach, describe, expect, it, vi } from "vitest";

import type { TenantContext } from "../../apps/control-web/src/lib/foundation/contracts";
import { createFixtureProjectionSet, FIXTURE_NOW_EPOCH, sourceSummary, type FixtureProjectionSet } from "../../apps/control-web/src/lib/harness-status/fixtures";
import { harnessSummary, planeSummary } from "../../apps/control-web/src/lib/harness-status/aggregation";
import { ProjectionStore, type SourceAdmissionPolicy } from "../../apps/control-web/src/lib/harness-status/projection-store";

const ORGANIZATION = "11111111-1111-4111-8111-111111111111";
const context: TenantContext = {
  schemaVersion: "planeon.control.foundation/v1",
  organizationId: ORGANIZATION,
  subjectDigest: `sha256:${"c".repeat(64)}`,
  sessionId: "22222222-2222-4222-8222-222222222222",
  admissionDigest: `sha256:${"d".repeat(64)}`,
  issuedAt: "2026-09-03T00:00:00Z",
  expiresAt: "2026-09-03T02:00:00Z",
};
const sourceAdmission: SourceAdmissionPolicy = { authorize: () => true };

describe("ordered atomic projection ingestion", () => {
  it("denies an otherwise valid source summary without an injected admission decision", () => {
    expect(() => new ProjectionStore().ingest(sourceSummary("PROFILE_LOCK", 1, createFixtureProjectionSet(ORGANIZATION)), FIXTURE_NOW_EPOCH)).toThrowError("STATUS_SOURCE_AUTHORITY_REFUSED");
  });

  it("applies once, replays without writes, and advances each source independently", () => {
    const store = new ProjectionStore(sourceAdmission);
    const profile = sourceSummary("PROFILE_LOCK", 1, createFixtureProjectionSet(ORGANIZATION));
    expect(store.ingest(profile, FIXTURE_NOW_EPOCH)).toBe("APPLIED");
    expect(store.ingest(profile, FIXTURE_NOW_EPOCH)).toBe("REPLAYED");
    expect(store.cursor(ORGANIZATION, "PROFILE_LOCK")?.sequence).toBe(1);
    expect(store.ingest(sourceSummary("RUNTIME_HEALTH", 1, createFixtureProjectionSet(ORGANIZATION)), FIXTURE_NOW_EPOCH)).toBe("APPLIED");
    expect(store.readOverview(context).spec.harnesses).toHaveLength(16);
  });

  it("rejects changed duplicates, gaps, future observations, and cross-binding snapshots atomically", () => {
    const store = new ProjectionStore(sourceAdmission);
    store.ingest(sourceSummary("PROFILE_LOCK", 1, createFixtureProjectionSet(ORGANIZATION)), FIXTURE_NOW_EPOCH);
    expect(() => store.ingest(sourceSummary("PROFILE_LOCK", 1, createFixtureProjectionSet(ORGANIZATION, "Changed projection")), FIXTURE_NOW_EPOCH)).toThrowError("STATUS_EVENT_CONFLICT");
    expect(() => store.ingest(sourceSummary("RUNTIME_HEALTH", 2, createFixtureProjectionSet(ORGANIZATION)), FIXTURE_NOW_EPOCH)).toThrowError("STATUS_CURSOR_GAP");
    expect(() => store.ingest(sourceSummary("TRUST_EVIDENCE", 1, createFixtureProjectionSet(ORGANIZATION)), Date.parse("2026-09-03T00:30:00Z") / 1000)).toThrowError("STATUS_SOURCE_ORDER_INVALID");
    expect(store.cursor(ORGANIZATION, "RUNTIME_HEALTH")).toBeUndefined();
    expect(store.cursor(ORGANIZATION, "TRUST_EVIDENCE")).toBeUndefined();
  });

  it("serves last verified facts with explicit source-unavailable degradation", () => {
    const store = new ProjectionStore(sourceAdmission);
    const projections = createFixtureProjectionSet(ORGANIZATION);
    store.ingest(sourceSummary("PROFILE_LOCK", 1, projections), FIXTURE_NOW_EPOCH);
    store.markSourceUnavailable(ORGANIZATION, "PROFILE_LOCK");
    const overview = store.readOverview(context);
    expect(overview.spec.freshness?.state).toBe("SOURCE_UNAVAILABLE");
    expect(overview.spec.aggregateState).toBe("BLOCKED");
    expect(overview.spec.harnesses.find((item) => item.harnessId === "runtime.infrastructure")?.aggregateState).toBe("BLOCKED");
    expect(projections.overview.spec.freshness?.state).toBe("CURRENT");
  });
});

function readyProjection(organizationId = ORGANIZATION, displayName = "Organization A", stale = false): FixtureProjectionSet {
  const original = createFixtureProjectionSet(organizationId, displayName);
  const freshness = { ...original.overview.spec.freshness!, state: stale ? "STALE" as const : "CURRENT" as const };
  const harnesses = original.harnesses.map((harness) => {
    const selected = harness.spec.harnessId === "runtime.infrastructure";
    return { ...harness, spec: { ...harness.spec, selectionState: selected ? "SELECTED" as const : "NOT_SELECTED" as const,
      installationState: selected ? "READY" as const : "ABSENT" as const,
      aggregateState: selected ? stale ? "BLOCKED" as const : "READY" as const : "EMPTY" as const,
      axes: harness.spec.axes.map((axis) => ({ ...axis, state: "PASS" as const, required: true, underlyingState: null, waiver: null, applicability: null })),
      freshness, findings: [], dependencies: [] } };
  });
  const summaries = harnesses.map(harnessSummary);
  const planes = original.planes.map((plane) => ({ ...plane, spec: { ...plane.spec,
    ...planeSummary(plane.spec.planeId, summaries.filter((harness) => harness.planeId === plane.spec.planeId)), freshness } }));
  return { harnesses, planes, overview: { ...original.overview, spec: { ...original.overview.spec,
    aggregateState: stale ? "BLOCKED" : "READY", freshness, priorityFindings: [],
    harnesses: summaries, planes: original.overview.spec.planes.map((plane) => planeSummary(plane.planeId, summaries.filter((harness) => harness.planeId === plane.planeId))),
    stateCounts: original.overview.spec.stateCounts.map((row) => ({ ...row, count: summaries.filter((harness) => harness.aggregateState === row.state).length })),
  } } };
}

describe("CTRL-FIX-003 immutable request-time materialization", () => {
  afterEach(() => vi.useRealTimers());

  function clock(epoch: number): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(epoch * 1000));
  }

  it("expires exactly at freshUntil without ingestion, including harness/detail/count/portfolio views", () => {
    clock(FIXTURE_NOW_EPOCH);
    const store = new ProjectionStore(sourceAdmission);
    const projections = readyProjection();
    const original = structuredClone(projections);
    store.ingest(sourceSummary("PROFILE_LOCK", 1, projections), FIXTURE_NOW_EPOCH);
    const cursor = structuredClone(store.cursor(ORGANIZATION, "PROFILE_LOCK"));
    const expiry = Date.parse(projections.overview.binding!.freshUntil);
    vi.setSystemTime(new Date(expiry - 1));
    expect(store.readHarness(context, "runtime.infrastructure").spec.aggregateState).toBe("READY");
    vi.setSystemTime(new Date(expiry));
    const overview = store.readOverview(context);
    const detail = store.readHarness(context, "runtime.infrastructure");
    const plane = store.readPlane(context, "runtime");
    expect(overview.spec.freshness?.state).toBe("STALE");
    expect(overview.spec.aggregateState).toBe("BLOCKED");
    expect(detail.spec.freshness.state).toBe("STALE");
    expect(detail.spec.aggregateState).toBe("BLOCKED");
    expect(plane.spec.freshness.state).toBe("STALE");
    expect(plane.spec.harnesses).toEqual(overview.spec.harnesses.filter((item) => item.planeId === "runtime"));
    expect(overview.spec.stateCounts.find((row) => row.state === "READY")?.count).toBe(0);
    expect(overview.spec.stateCounts.find((row) => row.state === "BLOCKED")?.count).toBe(1);
    expect(store.readHarness(context, "runtime.model-inference").spec.aggregateState).toBe("EMPTY");
    expect(store.readOrganization(ORGANIZATION)).toEqual(overview);
    expect(store.portfolio(1, null, "READY").spec.items).toEqual([]);
    expect(store.portfolio(1, null, "BLOCKED").spec.items[0]).toMatchObject({ aggregateState: "BLOCKED", freshnessState: "STALE" });
    expect(projections).toEqual(original);
    expect(detail.binding).toEqual(original.harnesses[0]!.binding);
    expect(store.cursor(ORGANIZATION, "PROFILE_LOCK")).toEqual(cursor);
  });

  it("materializes every organization before filtering and pagination under source outage", () => {
    clock(FIXTURE_NOW_EPOCH);
    const store = new ProjectionStore(sourceAdmission);
    for (const [id, name] of [["org.a", "Same name"], ["org.b", "Same name"], ["org.c", "Zulu"]]) {
      store.ingest(sourceSummary("PROFILE_LOCK", 1, readyProjection(id, name)), FIXTURE_NOW_EPOCH);
    }
    store.markSourceUnavailable("org.a", "PROFILE_LOCK");
    store.markSourceUnavailable("org.c", "RUNTIME_HEALTH");
    const first = store.portfolio(1, null, "BLOCKED");
    expect(first.spec.items.map((item) => item.binding.organizationId)).toEqual(["org.a"]);
    expect(first.spec.nextCursor).not.toBeNull();
    const second = store.portfolio(1, first.spec.nextCursor, "BLOCKED");
    expect(second.spec.items.map((item) => item.binding.organizationId)).toEqual(["org.c"]);
    expect(second.spec.nextCursor).toBeNull();
    expect(store.portfolio(10, null, "READY").spec.items.map((item) => item.binding.organizationId)).toEqual(["org.b"]);
    for (const row of [...first.spec.items, ...second.spec.items]) {
      const overview = store.readOrganization(row.binding.organizationId);
      expect(row.aggregateState).toBe(overview.spec.aggregateState);
      expect(row.freshnessState).toBe(overview.spec.freshness!.state);
      expect(row.binding).toEqual(overview.binding);
    }
    expect(() => store.portfolio(1, "invented-cursor", "BLOCKED")).toThrowError("STATUS_CURSOR_REFUSED");
    expect(() => store.readOverview({ ...context, organizationId: "org.unknown" })).toThrowError("STATUS_PROJECTION_NOT_FOUND");
  });

  it("preserves multiple outages through partial recovery, and full recovery does not renew expired bindings", () => {
    clock(FIXTURE_NOW_EPOCH);
    const store = new ProjectionStore(sourceAdmission);
    const original = readyProjection();
    const before = structuredClone(original);
    store.ingest(sourceSummary("PROFILE_LOCK", 1, original), FIXTURE_NOW_EPOCH);
    store.markSourceUnavailable(ORGANIZATION, "PROFILE_LOCK");
    store.markSourceUnavailable(ORGANIZATION, "RUNTIME_HEALTH");
    expect(store.readHarness(context, "runtime.infrastructure").spec.aggregateState).toBe("BLOCKED");
    store.ingest(sourceSummary("PROFILE_LOCK", 2, original), FIXTURE_NOW_EPOCH);
    expect(store.readOverview(context).spec.freshness?.state).toBe("SOURCE_UNAVAILABLE");
    const expiry = Date.parse(original.overview.binding!.freshUntil) / 1000;
    vi.setSystemTime(new Date(expiry * 1000));
    expect(store.readOverview(context).spec.freshness?.state).toBe("SOURCE_UNAVAILABLE");
    expect(store.portfolio(1, null, "BLOCKED").spec.items[0]?.freshnessState).toBe("SOURCE_UNAVAILABLE");
    store.ingest(sourceSummary("RUNTIME_HEALTH", 1, readyProjection(ORGANIZATION, "Organization A", true)), expiry);
    expect(store.readOverview(context).spec.freshness?.state).toBe("STALE");
    expect(store.readHarness(context, "runtime.infrastructure").spec.aggregateState).toBe("BLOCKED");
    expect(store.portfolio(1, null, "READY").spec.items).toEqual([]);
    expect(store.readOverview(context).binding!.freshUntil).toBe(before.overview.binding!.freshUntil);
    expect(original).toEqual(before);
  });

  it("does not retain mutable caller aliases or expose mutable admitted evidence on reads", () => {
    clock(FIXTURE_NOW_EPOCH);
    const store = new ProjectionStore(sourceAdmission);
    const mutable = structuredClone(readyProjection());
    store.ingest(sourceSummary("PROFILE_LOCK", 1, mutable), FIXTURE_NOW_EPOCH);
    const before = JSON.stringify(store.readOverview(context));
    (mutable.overview.binding as { freshUntil: string }).freshUntil = "2099-01-01T00:00:00Z";
    expect(JSON.stringify(store.readOverview(context))).toBe(before);
    const returned = store.readHarness(context, "runtime.infrastructure");
    expect(Object.isFrozen(returned.binding.sourceCursors[0])).toBe(true);
    expect(Object.isFrozen(returned.spec.axes[0])).toBe(true);
  });
});
