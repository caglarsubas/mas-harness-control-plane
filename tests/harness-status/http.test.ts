import { describe, expect, it } from "vitest";

import type { TenantContext } from "../../apps/control-web/src/lib/foundation/contracts";
import { getOrganizationOverview, getOrganizationPortfolio, getTenantHarness, getTenantOverview, getTenantPlane } from "../../apps/control-web/src/lib/harness-status/http";
import { createFixtureProjectionSet, FIXTURE_NOW_EPOCH, sourceSummary } from "../../apps/control-web/src/lib/harness-status/fixtures";
import { ProjectionStore, type OperatorPolicy } from "../../apps/control-web/src/lib/harness-status/projection-store";
import type { HarnessStatusRuntime, TenantStatusPolicy } from "../../apps/control-web/src/lib/harness-status/runtime";

const ORGANIZATION = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const context = (organizationId = ORGANIZATION): TenantContext => ({
  schemaVersion: "planeon.control.foundation/v1",
  organizationId,
  subjectDigest: `sha256:${"c".repeat(64)}`,
  sessionId: "22222222-2222-4222-8222-222222222222",
  admissionDigest: `sha256:${"d".repeat(64)}`,
  issuedAt: "2026-09-03T00:00:00Z",
  expiresAt: "2026-09-03T02:00:00Z",
});

class AllowTenant implements TenantStatusPolicy {
  authorize(_context: TenantContext, action: "harness:overview:view" | "harness:detail:view"): boolean { return action.startsWith("harness:"); }
}

class FixedOperator implements OperatorPolicy {
  constructor(private readonly allowed: boolean) {}
  authorize(): { allowed: boolean; policyDigest: string } { return { allowed: this.allowed, policyDigest: `sha256:${"e".repeat(64)}` }; }
}

function runtime(organizationId = ORGANIZATION, operatorAllowed = false): HarnessStatusRuntime {
  const store = new ProjectionStore({ authorize: () => true });
  store.ingest(sourceSummary("PROFILE_LOCK", 1, createFixtureProjectionSet(ORGANIZATION)), FIXTURE_NOW_EPOCH);
  return {
    store,
    authenticator: { authenticate: () => context(organizationId) },
    tenantPolicy: new AllowTenant(),
    operatorPolicy: new FixedOperator(operatorAllowed),
    nowEpoch: () => FIXTURE_NOW_EPOCH,
  };
}

const request = (resource: string, headers: HeadersInit = {}) => new Request(`https://control.local${resource}`, { headers });

describe("tenant and operator status HTTP", () => {
  it("serves overview, plane, and harness from server-derived tenant context", async () => {
    const app = runtime();
    expect((await getTenantOverview(request("/api/v1alpha1/overview"), app)).status).toBe(200);
    expect((await getTenantPlane(request("/api/v1alpha1/planes/knowledge"), app, "knowledge")).status).toBe(200);
    expect((await getTenantHarness(request("/api/v1alpha1/harnesses/knowledge.data-integration"), app, "knowledge.data-integration")).status).toBe(200);
  });

  it("rejects caller identity and makes cross-tenant and unknown objects indistinguishable", async () => {
    const foreign = runtime(OTHER);
    const crossTenant = await getTenantOverview(request("/api/v1alpha1/overview"), foreign);
    const unknown = await getTenantHarness(request("/api/v1alpha1/harnesses/unknown"), runtime(), "unknown");
    const callerIdentity = await getTenantOverview(request("/api/v1alpha1/overview", { "x-organization-id": ORGANIZATION }), runtime());
    expect(crossTenant.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect((await crossTenant.json()).code).toBe((await unknown.json()).code);
    expect(callerIdentity.status).toBe(400);
  });

  it("audits operator allow and deny before returning portfolio data", async () => {
    const denied = runtime(ORGANIZATION, false);
    expect((await getOrganizationPortfolio(request("/api/v1alpha1/organizations"), denied)).status).toBe(403);
    expect(denied.store.operatorAudit().map((record) => record.decision)).toEqual(["DENY"]);
    const allowed = runtime(ORGANIZATION, true);
    const result = await getOrganizationPortfolio(request("/api/v1alpha1/organizations?limit=1&state=BLOCKED"), allowed);
    expect(result.status).toBe(200);
    expect((await result.json()).spec.items).toHaveLength(1);
    expect(allowed.store.operatorAudit().map((record) => record.target)).toEqual(["LIST"]);
    expect((await getOrganizationOverview(request(`/api/v1alpha1/organizations/${OTHER}/overview`), denied, OTHER)).status).toBe(404);
    expect(denied.store.operatorAudit().at(-1)?.decision).toBe("DENY");
  });

  it("fails closed if operator audit cannot append", async () => {
    const app = runtime(ORGANIZATION, true);
    app.store.failNextAudit();
    expect((await getOrganizationPortfolio(request("/api/v1alpha1/organizations"), app)).status).toBe(503);
  });
});
