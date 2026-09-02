import { describe, expect, it } from "vitest";

import type { DemandProjection } from "../apps/control-web/src/lib/demands/contracts";
import { mutationFingerprint as demandFingerprint } from "../apps/control-web/src/lib/demands/service";
import type { TenantContext } from "../apps/control-web/src/lib/foundation/contracts";
import { InMemoryCompileInputResolver } from "../apps/control-web/src/lib/operations/dependencies";
import { getOperation, requestProfileCompilation } from "../apps/control-web/src/lib/operations/http";
import type { OperationRuntime } from "../apps/control-web/src/lib/operations/runtime";
import { OperationStore, operationMutationFingerprint } from "../apps/control-web/src/lib/operations/service";
import type { RequestAuthenticator } from "../apps/control-web/src/lib/questionnaire/runtime";
import {
  NOW,
  ORGANIZATION_B,
  REVIEWER_ONE_DIGEST,
  REVIEWER_TWO_DIGEST,
  context,
  createValidated,
  system,
} from "../tests/demands/fixture";

class FixtureAuthenticator implements RequestAuthenticator {
  constructor(private readonly tenant: TenantContext) {}

  authenticate(_request: Request, _mutation: boolean, _nowEpoch: number): TenantContext {
    return this.tenant;
  }
}

function approveDemand(): { readonly demand: DemandProjection; readonly demandEtag: string; readonly demandStore: ReturnType<typeof system>["store"] } {
  const { store } = system();
  const validated = createValidated(store);
  const approvalPath = `/api/v1alpha1/demands/${validated.body.id}/approve`;
  const requested = store.requestApproval(
    context(), validated.body.id, validated.etag, "compile-approval-request-001",
    demandFingerprint("POST", approvalPath, {}), NOW + 2,
  );
  const decisionPath = `/api/v1alpha1/approvals/${requested.body.id}/decision`;
  const decision = { decision: "APPROVE" as const, reasonCode: "REVIEW_COMPLETE" };
  const first = store.decide(
    context(REVIEWER_ONE_DIGEST), requested.body.id, decision, requested.etag,
    "compile-reviewer-one-001", demandFingerprint("POST", decisionPath, decision), NOW + 3,
  );
  store.decide(
    context(REVIEWER_TWO_DIGEST), requested.body.id, decision, first.etag,
    "compile-reviewer-two-001", demandFingerprint("POST", decisionPath, decision), NOW + 4,
  );
  const approved = store.readDemand(context(), validated.body.id);
  return { demand: approved.body, demandEtag: approved.etag, demandStore: store };
}

function registerInput(resolver: InMemoryCompileInputResolver, demand: DemandProjection): void {
  resolver.register({
    organizationId: context().organizationId,
    demandId: demand.id,
    demandRevision: demand.revision,
    demandDigest: demand.digest,
    questionnaireAnswerSetId: demand.source.questionnaireAnswerSetId,
    questionnaireAnswerSetDigest: demand.source.questionnaireAnswerSetDigest,
    readinessAssessmentId: demand.source.readinessAssessmentId,
    readinessAssessmentDigest: demand.source.readinessAssessmentDigest,
    environmentAttestationDigest: demand.tenantDemand.spec.environment.attestationDigest,
    compileRequest: Object.freeze({
      metadata: Object.freeze({
        tenantId: demand.tenantDemand.spec.tenantId,
        demandId: demand.tenantDemand.metadata.id,
      }),
    }),
    catalogResources: Object.freeze([Object.freeze({ kind: "HarnessClassDefinition" })]),
    catalogDigest: `sha256:${"8".repeat(64)}`,
  });
}

function runtime(tenant = context()): { readonly runtime: OperationRuntime; readonly store: OperationStore; readonly resolver: InMemoryCompileInputResolver; readonly demand: DemandProjection; readonly demandEtag: string } {
  const { demand, demandEtag, demandStore } = approveDemand();
  const resolver = new InMemoryCompileInputResolver();
  registerInput(resolver, demand);
  const store = new OperationStore(demandStore, resolver);
  return {
    demand,
    demandEtag,
    resolver,
    store,
    runtime: Object.freeze({ store, authenticator: new FixtureAuthenticator(tenant), nowEpoch: () => NOW + 5 }),
  };
}

function compileRequest(demandId: string, etag: string, idempotencyKey = "compile-operation-key-001", body = "{}"): Request {
  return new Request(`http://localhost/api/v1alpha1/demands/${demandId}/compile`, {
    method: "POST",
    headers: { "content-type": "application/json", "if-match": etag, "idempotency-key": idempotencyKey },
    body,
  });
}

describe("digest-bound profile compilation operation", () => {
  it("returns one PENDING operation and exact idempotent replay, then exposes tenant-scoped GET", async () => {
    const fixture = runtime();
    const first = await requestProfileCompilation(compileRequest(fixture.demand.id, fixture.demandEtag), fixture.runtime, fixture.demand.id);
    expect(first.status).toBe(202);
    const body = await first.json();
    expect(body.spec.state).toBe("PENDING");
    expect(body.spec.operationType).toBe("COMPILE_PROFILE");
    expect(body.spec.cancellable).toBe(false);
    expect(fixture.store.queuedJobs(context().organizationId)).toHaveLength(1);
    expect(fixture.store.queuedJobs(context().organizationId)[0].compileRequest).toEqual({
      metadata: {
        tenantId: fixture.demand.tenantDemand.spec.tenantId,
        demandId: fixture.demand.tenantDemand.metadata.id,
      },
    });
    expect(fixture.store.queuedJobs(context().organizationId)[0].catalogResources).toEqual([
      { kind: "HarnessClassDefinition" },
    ]);
    expect(fixture.store.auditEvents(context().organizationId)).toHaveLength(1);

    const replay = await requestProfileCompilation(compileRequest(fixture.demand.id, fixture.demandEtag), fixture.runtime, fixture.demand.id);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(body);
    expect(replay.headers.get("etag")).toBe(first.headers.get("etag"));
    expect(fixture.store.queuedJobs(context().organizationId)).toHaveLength(1);

    const read = await getOperation(new Request(`http://localhost/api/v1alpha1/operations/${body.metadata.id}`), fixture.runtime, body.metadata.id);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(body);
  });

  it("fails closed for precondition, current-state, resolver, and caller-authority errors", async () => {
    const fixture = runtime();
    const missingRequest = new Request(`http://localhost/api/v1alpha1/demands/${fixture.demand.id}/compile`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "compile-missing-etag-001" },
      body: "{}",
    });
    const missing = await requestProfileCompilation(missingRequest, fixture.runtime, fixture.demand.id);
    expect(missing.status).toBe(428);
    const stale = await requestProfileCompilation(compileRequest(fixture.demand.id, '"stale"', "compile-stale-etag-001"), fixture.runtime, fixture.demand.id);
    expect(stale.status).toBe(412);
    fixture.resolver.setUnavailable(true);
    const unavailable = await requestProfileCompilation(compileRequest(fixture.demand.id, fixture.demandEtag, "compile-unavailable-001"), fixture.runtime, fixture.demand.id);
    expect(unavailable.status).toBe(503);
    fixture.resolver.setUnavailable(false);
    const authority = await requestProfileCompilation(
      compileRequest(fixture.demand.id, fixture.demandEtag, "compile-authority-body-001", '{"tenantId":"tenant.attacker"}'),
      fixture.runtime,
      fixture.demand.id,
    );
    expect(authority.status).toBe(400);

    const unapprovedSystem = system();
    const validated = createValidated(unapprovedSystem.store);
    const unapprovedResolver = new InMemoryCompileInputResolver();
    registerInput(unapprovedResolver, validated.body);
    const unapprovedStore = new OperationStore(unapprovedSystem.store, unapprovedResolver);
    const unapprovedRuntime: OperationRuntime = Object.freeze({
      store: unapprovedStore,
      authenticator: new FixtureAuthenticator(context()),
      nowEpoch: () => NOW + 2,
    });
    const refused = await requestProfileCompilation(compileRequest(validated.body.id, validated.etag, "compile-unapproved-001"), unapprovedRuntime, validated.body.id);
    expect(refused.status).toBe(409);
    expect(unapprovedStore.queuedJobs(context().organizationId)).toHaveLength(0);
  });

  it("keeps idempotency conflict, audit failure, stale inputs, and cross-tenant reads atomic", async () => {
    const fixture = runtime();
    const path = `/api/v1alpha1/demands/${fixture.demand.id}/compile`;
    fixture.store.requestCompilation(
      context(), fixture.demand.id, fixture.demandEtag, "compile-direct-key-001",
      operationMutationFingerprint("POST", path, {}), NOW + 5,
    );
    expect(() => fixture.store.requestCompilation(
      context(), fixture.demand.id, fixture.demandEtag, "compile-direct-key-001",
      `sha256:${"9".repeat(64)}`, NOW + 5,
    )).toThrowError("IDEMPOTENCY_CONFLICT");

    fixture.store.failNextAuditForTest();
    expect(() => fixture.store.requestCompilation(
      context(), fixture.demand.id, fixture.demandEtag, "compile-audit-failure-001",
      operationMutationFingerprint("POST", path, {}), NOW + 5,
    )).toThrowError("AUDIT_WRITE_REFUSED");
    expect(fixture.store.queuedJobs(context().organizationId)).toHaveLength(1);

    const operation = fixture.store.queuedJobs(context().organizationId)[0];
    const crossTenantRuntime: OperationRuntime = Object.freeze({
      store: fixture.store,
      authenticator: new FixtureAuthenticator(context(undefined, ORGANIZATION_B)),
      nowEpoch: () => NOW + 5,
    });
    const denied = await getOperation(
      new Request(`http://localhost/api/v1alpha1/operations/${operation.operationId}`),
      crossTenantRuntime,
      operation.operationId,
    );
    expect(denied.status).toBe(404);

    const staleFixture = runtime();
    staleFixture.resolver.register({
      organizationId: context().organizationId,
      demandId: staleFixture.demand.id,
      demandRevision: staleFixture.demand.revision + 1,
      demandDigest: staleFixture.demand.digest,
      questionnaireAnswerSetId: staleFixture.demand.source.questionnaireAnswerSetId,
      questionnaireAnswerSetDigest: staleFixture.demand.source.questionnaireAnswerSetDigest,
      readinessAssessmentId: staleFixture.demand.source.readinessAssessmentId,
      readinessAssessmentDigest: staleFixture.demand.source.readinessAssessmentDigest,
      environmentAttestationDigest: staleFixture.demand.tenantDemand.spec.environment.attestationDigest,
      compileRequest: { metadata: { tenantId: staleFixture.demand.tenantDemand.spec.tenantId, demandId: staleFixture.demand.tenantDemand.metadata.id } },
      catalogResources: [{ kind: "HarnessClassDefinition" }],
      catalogDigest: `sha256:${"8".repeat(64)}`,
    });
    expect(() => staleFixture.store.requestCompilation(
      context(), staleFixture.demand.id, staleFixture.demandEtag, "compile-stale-input-001",
      operationMutationFingerprint("POST", `/api/v1alpha1/demands/${staleFixture.demand.id}/compile`, {}), NOW + 5,
    )).toThrowError("COMPILE_INPUT_STALE");
  });

  it("emits canonical RUNNING and SUCCEEDED lifecycle events and refuses terminal mutation", () => {
    const fixture = runtime();
    const requested = fixture.store.requestCompilation(
      context(), fixture.demand.id, fixture.demandEtag, "compile-transition-key-001",
      operationMutationFingerprint("POST", `/api/v1alpha1/demands/${fixture.demand.id}/compile`, {}), NOW + 5,
    );
    const running = fixture.store.applyWorkerTransition(
      context().organizationId, requested.body.metadata.id, "RUNNING", "COMPILATION_STARTED", NOW + 6,
    );
    expect(running.spec.state).toBe("RUNNING");
    const succeeded = fixture.store.applyWorkerTransition(
      context().organizationId,
      requested.body.metadata.id,
      "SUCCEEDED",
      "COMPILATION_SUCCEEDED",
      NOW + 7,
      [{ kind: "harness-profile", id: "profile.fixture", digest: `sha256:${"a".repeat(64)}` }],
    );
    expect(succeeded.spec.state).toBe("SUCCEEDED");
    expect(fixture.store.outboxEvents(context().organizationId).map((event) => event.data.transition)).toEqual([
      { from: "PENDING", to: "RUNNING" },
      { from: "RUNNING", to: "SUCCEEDED" },
    ]);
    expect(() => fixture.store.applyWorkerTransition(
      context().organizationId, requested.body.metadata.id, "FAILED", "TOO_LATE", NOW + 8, [],
      { reasonCode: "TOO_LATE", retryable: false, evidenceRefs: [] },
    )).toThrowError("OPERATION_TRANSITION_REFUSED");
  });
});
