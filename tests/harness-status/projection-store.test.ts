import { describe, expect, it } from "vitest";

import type { TenantContext } from "../../apps/control-web/src/lib/foundation/contracts";
import { createFixtureProjectionSet, FIXTURE_NOW_EPOCH, sourceSummary } from "../../apps/control-web/src/lib/harness-status/fixtures";
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
