import { describe, expect, it } from "vitest";

import { FOUNDATION_SCHEMA, ControlError, type TenantContext } from "../../apps/control-web/src/lib/foundation/contracts";
import {
  createQuestionnaireSession,
  getQuestionnaireSession,
  listQuestionnaires,
  reviewQuestionnaireSession,
  saveQuestionnaireAnswers,
} from "../../apps/control-web/src/lib/questionnaire/http";
import { admitIndustryPack, AdmittedIndustryPackRegistry } from "../../apps/control-web/src/lib/questionnaire/pack";
import type { QuestionnaireRuntime, RequestAuthenticator } from "../../apps/control-web/src/lib/questionnaire/runtime";
import { QuestionnaireSessionStore } from "../../apps/control-web/src/lib/questionnaire/session";
import { buildSignedPackFixture } from "./fixture";

const NOW = Date.parse("2026-06-01T00:00:00Z") / 1000;
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

function tenant(organizationId: string): TenantContext {
  return {
    schemaVersion: FOUNDATION_SCHEMA,
    organizationId,
    subjectDigest: `sha256:${(organizationId === TENANT_A ? "a" : "b").repeat(64)}`,
    sessionId: organizationId,
    admissionDigest: `sha256:${"c".repeat(64)}`,
    issuedAt: "2026-06-01T00:00:00Z",
    expiresAt: "2026-06-01T08:00:00Z",
  };
}

class FixtureAuthenticator implements RequestAuthenticator {
  authenticate(request: Request, mutation: boolean): TenantContext {
    const cookie = request.headers.get("cookie");
    const organizationId = cookie === "fixture=b" ? TENANT_B : cookie === "fixture=a" ? TENANT_A : null;
    if (!organizationId) throw new ControlError("SESSION_REFUSED", 401);
    if (mutation && request.headers.get("x-csrf-token") !== "fixture-csrf-token-00000000000000") throw new ControlError("CSRF_REFUSED", 403);
    return tenant(organizationId);
  }
}

function runtime(): QuestionnaireRuntime {
  const fixture = buildSignedPackFixture();
  const pack = admitIndustryPack(fixture.envelope, fixture.archive, fixture.registry, NOW);
  const packs = new AdmittedIndustryPackRegistry();
  packs.admit(pack);
  return {
    packs,
    sessions: new QuestionnaireSessionStore(packs),
    authenticator: new FixtureAuthenticator(),
    nowEpoch: () => NOW,
  };
}

function request(path: string, init: RequestInit = {}, tenantCookie = "fixture=a"): Request {
  return new Request(`https://control.local${path}`, {
    ...init,
    headers: {
      cookie: tenantCookie,
      ...(init.headers ?? {}),
    },
  });
}

const mutationHeaders = {
  "content-type": "application/json",
  "idempotency-key": "http-request-001",
  "x-csrf-token": "fixture-csrf-token-00000000000000",
};

describe("questionnaire HTTP adapters", () => {
  it("lists only admitted projections and creates an ETag-bound session", async () => {
    const app = runtime();
    const listed = await listQuestionnaires(request("/api/v1alpha1/questionnaires"), app);
    expect(listed.status).toBe(200);
    const catalogue = await listed.json() as { items: { packId: string; stages: unknown[] }[] };
    expect(catalogue.items).toHaveLength(1);
    expect(catalogue.items[0].packId).toBe("white-goods.synthetic");
    expect(catalogue.items[0].stages).toHaveLength(8);

    const created = await createQuestionnaireSession(request("/api/v1alpha1/sessions", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ packId: "white-goods.synthetic", packVersion: "0.5.0" }),
    }), app);
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/u);
    expect(created.headers.get("cache-control")).toBe("no-store");
  });

  it("requires server session, CSRF, idempotency, and update preconditions", async () => {
    const app = runtime();
    const missingCsrf = await createQuestionnaireSession(request("/api/v1alpha1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "missing-csrf-001" },
      body: JSON.stringify({ packId: "white-goods.synthetic", packVersion: "0.5.0" }),
    }), app);
    expect(missingCsrf.status).toBe(403);

    const missingIdempotency = await createQuestionnaireSession(request("/api/v1alpha1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": mutationHeaders["x-csrf-token"] },
      body: JSON.stringify({ packId: "white-goods.synthetic", packVersion: "0.5.0" }),
    }), app);
    expect(missingIdempotency.status).toBe(400);

    const created = await createQuestionnaireSession(request("/api/v1alpha1/sessions", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ packId: "white-goods.synthetic", packVersion: "0.5.0" }),
    }), app);
    const session = await created.json() as { id: string };
    const noMatch = await saveQuestionnaireAnswers(request(`/api/v1alpha1/sessions/${session.id}/answers`, {
      method: "PUT",
      headers: { ...mutationHeaders, "idempotency-key": "missing-match-001" },
      body: JSON.stringify({ stageId: "business-context", answers: [] }),
    }), app, session.id);
    expect(noMatch.status).toBe(428);
  });

  it("returns exact mutation replay and an indistinguishable cross-tenant 404 envelope", async () => {
    const app = runtime();
    const body = JSON.stringify({ packId: "white-goods.synthetic", packVersion: "0.5.0" });
    const first = await createQuestionnaireSession(request("/api/v1alpha1/sessions", { method: "POST", headers: mutationHeaders, body }), app);
    const firstPayload = await first.clone().json() as { id: string };
    const replay = await createQuestionnaireSession(request("/api/v1alpha1/sessions", { method: "POST", headers: mutationHeaders, body }), app);
    expect(await replay.json()).toEqual(await first.json());
    expect(replay.headers.get("etag")).toBe(first.headers.get("etag"));

    const crossTenant = await getQuestionnaireSession(request(`/api/v1alpha1/sessions/${firstPayload.id}`, {}, "fixture=b"), app, firstPayload.id);
    const unknown = await getQuestionnaireSession(request("/api/v1alpha1/sessions/33333333-3333-4333-8333-333333333333"), app, "33333333-3333-4333-8333-333333333333");
    expect(crossTenant.status).toBe(404);
    expect(unknown.status).toBe(404);
    const sanitize = ({ correlationId: _ignored, ...value }: Record<string, unknown>) => value;
    expect(sanitize(await crossTenant.json() as Record<string, unknown>)).toEqual(sanitize(await unknown.json() as Record<string, unknown>));
  });

  it("rejects caller-supplied identity and duplicate JSON members", async () => {
    const app = runtime();
    const tenantHeader = await listQuestionnaires(request("/api/v1alpha1/questionnaires", {
      headers: { "x-tenant-id": TENANT_A },
    }), app);
    expect(tenantHeader.status).toBe(400);

    const duplicate = await createQuestionnaireSession(request("/api/v1alpha1/sessions", {
      method: "POST",
      headers: mutationHeaders,
      body: '{"packId":"white-goods.synthetic","packId":"other","packVersion":"0.5.0"}',
    }), app);
    expect(duplicate.status).toBe(400);
  });

  it("persists answer and review through the REST semantics", async () => {
    const app = runtime();
    const created = await createQuestionnaireSession(request("/api/v1alpha1/sessions", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ packId: "white-goods.synthetic", packVersion: "0.5.0" }),
    }), app);
    const session = await created.json() as { id: string };
    const saved = await saveQuestionnaireAnswers(request(`/api/v1alpha1/sessions/${session.id}/answers`, {
      method: "PUT",
      headers: { ...mutationHeaders, "idempotency-key": "http-answer-001", "if-match": created.headers.get("etag")! },
      body: JSON.stringify({
        stageId: "business-context",
        answers: [{ questionId: "owner", value: "Tenant owner", source: "TENANT_DECLARATION" }],
      }),
    }), app, session.id);
    expect(saved.status).toBe(200);
    const reviewed = await reviewQuestionnaireSession(request(`/api/v1alpha1/sessions/${session.id}/review`, {
      method: "POST",
      headers: { ...mutationHeaders, "idempotency-key": "http-review-001", "if-match": saved.headers.get("etag")! },
      body: "{}",
    }), app, session.id);
    expect(reviewed.status).toBe(200);
    expect((await reviewed.json() as { state: string }).state).toBe("BLOCKED");
  });
});
