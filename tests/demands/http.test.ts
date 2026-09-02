import { describe, expect, it } from "vitest";

import { ControlError, type TenantContext } from "../../apps/control-web/src/lib/foundation/contracts";
import {
  createDemand,
  getApproval,
  getDemand,
  recordApprovalDecision,
  requestDemandApproval,
  validateDemand,
} from "../../apps/control-web/src/lib/demands/http";
import type { DemandRuntime } from "../../apps/control-web/src/lib/demands/runtime";
import type { RequestAuthenticator } from "../../apps/control-web/src/lib/questionnaire/runtime";
import {
  NOW,
  ORGANIZATION_B,
  REVIEWER_ONE_DIGEST,
  REVIEWER_TWO_DIGEST,
  context,
  input,
  system,
} from "./fixture";

class FixtureAuthenticator implements RequestAuthenticator {
  authenticate(request: Request, mutation: boolean): TenantContext {
    const cookie = request.headers.get("cookie");
    const admitted = cookie === "fixture=requester" ? context()
      : cookie === "fixture=reviewer-one" ? context(REVIEWER_ONE_DIGEST)
        : cookie === "fixture=reviewer-two" ? context(REVIEWER_TWO_DIGEST)
          : cookie === "fixture=other" ? context(undefined, ORGANIZATION_B)
            : null;
    if (!admitted) throw new ControlError("SESSION_REFUSED", 401);
    if (mutation && request.headers.get("x-csrf-token") !== "fixture-csrf-token-00000000000000") {
      throw new ControlError("CSRF_REFUSED", 403);
    }
    return admitted;
  }
}

function runtime(): DemandRuntime {
  const fixture = system();
  return { store: fixture.store, authenticator: new FixtureAuthenticator(), nowEpoch: () => NOW };
}

function request(path: string, init: RequestInit = {}, cookie = "fixture=requester"): Request {
  return new Request(`https://control.local${path}`, {
    ...init,
    headers: { cookie, ...(init.headers ?? {}) },
  });
}

function mutationHeaders(key: string, etag?: string): HeadersInit {
  return {
    "content-type": "application/json",
    "idempotency-key": key,
    "x-csrf-token": "fixture-csrf-token-00000000000000",
    ...(etag ? { "if-match": etag } : {}),
  };
}

async function createdDemand(app: DemandRuntime) {
  const created = await createDemand(request("/api/v1alpha1/demands", {
    method: "POST", headers: mutationHeaders("http-demand-create-001"), body: JSON.stringify(input()),
  }), app);
  return { response: created, body: await created.clone().json() as { id: string; state: string } };
}

describe("demand and approval HTTP adapters", () => {
  it("executes create, validate, request, read, and N-of-M decision behavior", async () => {
    const app = runtime();
    const created = await createdDemand(app);
    expect(created.response.status).toBe(201);
    expect(created.body.state).toBe("DRAFT");
    expect(created.response.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/u);

    const validated = await validateDemand(request(`/api/v1alpha1/demands/${created.body.id}/validate`, {
      method: "POST", headers: mutationHeaders("http-demand-validate-001", created.response.headers.get("etag")!), body: "{}",
    }), app, created.body.id);
    expect(validated.status).toBe(200);
    expect((await validated.clone().json() as { state: string }).state).toBe("VALIDATED");

    const requested = await requestDemandApproval(request(`/api/v1alpha1/demands/${created.body.id}/approve`, {
      method: "POST", headers: mutationHeaders("http-approval-request-001", validated.headers.get("etag")!), body: "{}",
    }), app, created.body.id);
    const approval = await requested.clone().json() as { id: string; state: string; approvedDecisionCount: number };
    expect(requested.status).toBe(201);
    expect(approval.state).toBe("PENDING");

    const read = await getApproval(request(`/api/v1alpha1/approvals/${approval.id}`), app, approval.id);
    expect(read.status).toBe(200);
    const first = await recordApprovalDecision(request(`/api/v1alpha1/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: mutationHeaders("http-review-one-001", read.headers.get("etag")!),
      body: JSON.stringify({ decision: "APPROVE", reasonCode: "REVIEW_COMPLETE" }),
    }, "fixture=reviewer-one"), app, approval.id);
    expect((await first.clone().json() as { state: string }).state).toBe("PENDING");
    const second = await recordApprovalDecision(request(`/api/v1alpha1/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: mutationHeaders("http-review-two-001", first.headers.get("etag")!),
      body: JSON.stringify({ decision: "APPROVE", reasonCode: "REVIEW_COMPLETE" }),
    }, "fixture=reviewer-two"), app, approval.id);
    expect((await second.json() as { state: string }).state).toBe("APPROVED");

    const demand = await getDemand(request(`/api/v1alpha1/demands/${created.body.id}`), app, created.body.id);
    expect((await demand.json() as { state: string }).state).toBe("APPROVED");
  });

  it("requires secure session, CSRF, idempotency, and strong update preconditions", async () => {
    const app = runtime();
    const noCsrf = await createDemand(request("/api/v1alpha1/demands", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "missing-csrf-001" }, body: JSON.stringify(input()),
    }), app);
    expect(noCsrf.status).toBe(403);
    const noIdempotency = await createDemand(request("/api/v1alpha1/demands", {
      method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "fixture-csrf-token-00000000000000" }, body: JSON.stringify(input()),
    }), app);
    expect(noIdempotency.status).toBe(400);
    const created = await createdDemand(app);
    const noMatch = await validateDemand(request(`/api/v1alpha1/demands/${created.body.id}/validate`, {
      method: "POST", headers: mutationHeaders("missing-match-001"), body: "{}",
    }), app, created.body.id);
    expect(noMatch.status).toBe(428);
  });

  it("returns exact replay and indistinguishable cross-tenant not-found envelopes", async () => {
    const app = runtime();
    const body = JSON.stringify(input());
    const first = await createDemand(request("/api/v1alpha1/demands", {
      method: "POST", headers: mutationHeaders("http-exact-replay-001"), body,
    }), app);
    const replay = await createDemand(request("/api/v1alpha1/demands", {
      method: "POST", headers: mutationHeaders("http-exact-replay-001"), body,
    }), app);
    expect(await replay.json()).toEqual(await first.clone().json());
    expect(replay.headers.get("etag")).toBe(first.headers.get("etag"));
    const demand = await first.json() as { id: string };
    const cross = await getDemand(request(`/api/v1alpha1/demands/${demand.id}`, {}, "fixture=other"), app, demand.id);
    const unknown = await getDemand(request("/api/v1alpha1/demands/66666666-6666-4666-8666-666666666666"), app, "66666666-6666-4666-8666-666666666666");
    expect(cross.status).toBe(404);
    expect(unknown.status).toBe(404);
    const sanitize = ({ correlationId: _ignored, ...value }: Record<string, unknown>) => value;
    expect(sanitize(await cross.json() as Record<string, unknown>)).toEqual(sanitize(await unknown.json() as Record<string, unknown>));
  });

  it("rejects caller identity, duplicate JSON members, and extra nested demand fields", async () => {
    const app = runtime();
    const callerTenant = await createDemand(request("/api/v1alpha1/demands", {
      method: "POST",
      headers: { ...mutationHeaders("caller-tenant-001"), "x-tenant-id": "tenant.attacker" },
      body: JSON.stringify(input()),
    }), app);
    expect(callerTenant.status).toBe(400);
    const duplicate = await createDemand(request("/api/v1alpha1/demands", {
      method: "POST",
      headers: mutationHeaders("duplicate-json-001"),
      body: `{"source":{},"source":{},"requestedCapabilities":[],"proposedPrerequisiteHarnessIds":[],"prerequisiteDecisions":[],"environment":{},"assuranceSubjects":{},"executionBudget":{}}`,
    }), app);
    expect(duplicate.status).toBe(400);
    const nestedTenant = input({ environment: { ...input().environment, tenantId: "tenant.attacker" } as never });
    const extra = await createDemand(request("/api/v1alpha1/demands", {
      method: "POST", headers: mutationHeaders("nested-tenant-001"), body: JSON.stringify(nestedTenant),
    }), app);
    expect(extra.status).toBe(422);
  });
});
