import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../apps/control-web/src/lib/foundation/canonical";
import { profileMutationFingerprint } from "../../apps/control-web/src/lib/profiles/service";
import {
  NOW,
  ORGANIZATION_B,
  PROFILE_ID,
  REQUESTER,
  REVIEWER_ONE,
  REVIEWER_TWO,
  SOURCE_ID,
  approveProfile,
  context,
  lockProfile,
  requestApproval,
  requestBundle,
  signedEnvelope,
  system,
} from "./fixture";

describe("CTRL-005 profile approval and lock lifecycle", () => {
  it("requires two distinct eligible reviewers and excludes the requester", () => {
    const { store } = system();
    let approval = requestApproval(store);
    const path = `/api/v1alpha1/profiles/${PROFILE_ID}/approval/decision`;
    const body = { decision: "APPROVE" as const, reasonCode: "REVIEW_COMPLETE" };
    expect(() => store.decide(context(REQUESTER), PROFILE_ID, body, approval.etag, "requester-review-001", profileMutationFingerprint("POST", path, body), NOW + 1)).toThrowError("PROFILE_REVIEWER_REFUSED");
    approval = store.decide(context(REVIEWER_ONE), PROFILE_ID, body, approval.etag, "distinct-review-one-001", profileMutationFingerprint("POST", path, body), NOW + 2);
    expect(approval.body.state).toBe("PENDING");
    expect(() => store.decide(context(REVIEWER_ONE), PROFILE_ID, body, approval.etag, "repeat-reviewer-one-001", profileMutationFingerprint("POST", path, body), NOW + 3)).toThrowError("PROFILE_REVIEWER_REFUSED");
    approval = store.decide(context(REVIEWER_TWO), PROFILE_ID, body, approval.etag, "distinct-review-two-001", profileMutationFingerprint("POST", path, body), NOW + 4);
    expect(approval.body.state).toBe("APPROVED");
    expect(approval.body.approvedDecisionCount).toBe(2);
  });

  it("moves a rejected profile to a terminal internal state without rewriting PLANNED compiler bytes", () => {
    const { store } = system();
    const approval = requestApproval(store);
    const path = `/api/v1alpha1/profiles/${PROFILE_ID}/approval/decision`;
    const body = { decision: "REJECT" as const, reasonCode: "REQUIREMENTS_REJECTED" };
    const rejected = store.decide(context(REVIEWER_ONE), PROFILE_ID, body, approval.etag, "profile-reject-001", profileMutationFingerprint("POST", path, body), NOW + 1);
    expect(rejected.body.state).toBe("REJECTED");
    const profile = store.readProfile(context(), PROFILE_ID).body;
    expect(profile.state).toBe("REJECTED");
    expect((profile.profile.spec as Record<string, unknown>).state).toBe("PLANNED");
  });

  it("enforces missing and stale preconditions plus stable idempotent replay", () => {
    const { store } = system();
    const current = store.readProfile(context(), PROFILE_ID);
    const path = `/api/v1alpha1/profiles/${PROFILE_ID}/approve`;
    const fingerprint = profileMutationFingerprint("POST", path, {});
    expect(() => store.requestApproval(context(), PROFILE_ID, null, "approval-precondition-001", fingerprint, NOW)).toThrowError("PRECONDITION_REQUIRED");
    expect(() => store.requestApproval(context(), PROFILE_ID, '"stale"', "approval-precondition-002", fingerprint, NOW)).toThrowError("PRECONDITION_FAILED");
    const first = store.requestApproval(context(), PROFILE_ID, current.etag, "approval-replay-key-001", fingerprint, NOW);
    const replay = store.requestApproval(context(), PROFILE_ID, '"ignored-on-replay"', "approval-replay-key-001", fingerprint, NOW + 99);
    expect(replay).toEqual(first);
    expect(() => store.requestApproval(context(), PROFILE_ID, current.etag, "approval-replay-key-001", profileMutationFingerprint("POST", `${path}/different`, {}), NOW)).toThrowError("IDEMPOTENCY_CONFLICT");
  });

  it("refuses expired approval authority", () => {
    const { store } = system([], "2026-06-01T00:00:05Z");
    const approval = requestApproval(store);
    const path = `/api/v1alpha1/profiles/${PROFILE_ID}/approval/decision`;
    const body = { decision: "APPROVE" as const, reasonCode: "REVIEW_COMPLETE" };
    expect(() => store.decide(context(REVIEWER_ONE), PROFILE_ID, body, approval.etag, "expired-review-001", profileMutationFingerprint("POST", path, body), NOW + 10)).toThrowError("PROFILE_APPROVAL_EXPIRED");
  });

  it("computes the canonical lock from every immutable binding and refuses a second lock", () => {
    const { store } = system();
    const firstLock = lockProfile(store);
    const current = store.readProfile(context(), PROFILE_ID);
    const approval = store.readApproval(context(), PROFILE_ID).body;
    expect(firstLock.body.digest).toBe(sha256(canonicalJson({
      organizationId: context().organizationId,
      profileId: PROFILE_ID,
      profileRevision: 1,
      resultKey: current.body.resultKey,
      demand: current.body.demand,
      compilerWheelDigest: current.body.compilerWheelDigest,
      catalogDigest: current.body.catalogDigest,
      outputDigests: current.body.outputDigests,
      approval: { id: approval.id, revision: approval.revision, digest: approval.digest, policyDigest: approval.policyDigest },
    })));
    expect(() => store.lock(context(), PROFILE_ID, current.etag, "second-lock-request-001", profileMutationFingerprint("POST", `/api/v1alpha1/profiles/${PROFILE_ID}/lock`, {}), NOW + 50)).toThrowError("PROFILE_LOCK_STATE_REFUSED");
  });

  it("detects an output mutation after lock without rewriting or unlocking the receipt", () => {
    const { store } = system();
    const locked = lockProfile(store);
    store.tamperOutputForTest(context().organizationId, PROFILE_ID, "explanation.md", Buffer.from("changed after lock\n"));
    expect(() => store.readProfile(context(), PROFILE_ID)).toThrowError("PROFILE_REVISION_TAMPERED");
    expect(locked.body.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("does not commit approval state when its audit record fails", () => {
    const { store } = system();
    const current = store.readProfile(context(), PROFILE_ID);
    store.failNextAuditForTest();
    expect(() => store.requestApproval(context(), PROFILE_ID, current.etag, "audit-failure-request-001", profileMutationFingerprint("POST", `/api/v1alpha1/profiles/${PROFILE_ID}/approve`, {}), NOW)).toThrowError("AUDIT_WRITE_REFUSED");
    expect(store.readProfile(context(), PROFILE_ID).body.state).toBe("PROPOSED");
    expect(store.auditEvents(context().organizationId)).toHaveLength(0);
  });

  it("hides both unknown and cross-tenant profile identifiers behind the same refusal", () => {
    const { store } = system();
    expect(() => store.readProfile(context(REQUESTER, ORGANIZATION_B), PROFILE_ID)).toThrowError("PROFILE_NOT_FOUND");
    expect(() => store.readProfile(context(), "profile.unknown")).toThrowError("PROFILE_NOT_FOUND");
  });
});

describe("CTRL-005 bundle handoff", () => {
  it("creates one durable request and one pending BUILD_BUNDLE operation without artifact claims", () => {
    const { store, operations } = system();
    const requested = requestBundle(store);
    expect(requested.status).toBe(202);
    expect(requested.body.state).toBe("REQUESTED");
    expect(requested.body.operation.spec).toMatchObject({ operationType: "BUILD_BUNDLE", state: "PENDING", resultRefs: [] });
    expect(requested.body.release).toBeNull();
    expect(requested.body.sourceFreshness).toBe("SOURCE_UNAVAILABLE");
    expect(store.bundleCount()).toBe(1);
    expect(store.outboxRecords(context().organizationId).at(-1)?.eventType).toBe("bundle.requested.v1");
    expect(operations.outboxEvents(context().organizationId)).toHaveLength(0);
  });

  it("replays the exact bundle request and rejects a second request for the same lock", () => {
    const { store } = system();
    const first = requestBundle(store);
    const body = { profileId: PROFILE_ID };
    const fingerprint = profileMutationFingerprint("POST", "/api/v1alpha1/bundles", body);
    expect(store.requestBundle(context(), PROFILE_ID, '"ignored-on-replay"', "profile-bundle-request-001", fingerprint, NOW + 50)).toEqual(first);
    const current = store.readProfile(context(), PROFILE_ID);
    expect(() => store.requestBundle(context(), PROFILE_ID, current.etag, "profile-bundle-request-002", fingerprint, NOW + 51)).toThrowError("BUNDLE_REQUEST_EXISTS");
    expect(store.bundleCount()).toBe(1);
  });

  it("does not create an operation or request when bundle audit persistence fails", () => {
    const { store, operations } = system();
    lockProfile(store);
    const current = store.readProfile(context(), PROFILE_ID);
    const body = { profileId: PROFILE_ID };
    store.failNextAuditForTest();
    expect(() => store.requestBundle(context(), PROFILE_ID, current.etag, "bundle-audit-failure-001", profileMutationFingerprint("POST", "/api/v1alpha1/bundles", body), NOW + 40)).toThrowError("AUDIT_WRITE_REFUSED");
    expect(store.bundleCount()).toBe(0);
    expect(operations.auditEvents(context().organizationId)).toHaveLength(0);
  });

  it("admits one authenticated ordered SIGNED source report and marks it source-reported only", () => {
    const { store, operations } = system();
    const requested = requestBundle(store);
    const profileDigest = store.readProfile(context(), PROFILE_ID).body.reviewDigest;
    const envelope = signedEnvelope(requested.body.id, profileDigest);
    const accepted = store.reportSignedBundle("source.bundle-distribution", envelope, NOW + 60);
    expect(accepted.body.state).toBe("SOURCE_REPORTED_SIGNED");
    expect(accepted.body.evidenceBoundary).toBe("SOURCE_REPORTED_ONLY");
    expect(accepted.body.operation.spec.state).toBe("SUCCEEDED");
    expect(accepted.body.operation.spec.resultRefs).toHaveLength(1);
    expect(operations.outboxEvents(context().organizationId).map((event) => event.data.transition)).toEqual([
      { from: "PENDING", to: "RUNNING" }, { from: "RUNNING", to: "SUCCEEDED" },
    ]);
    expect(store.readProfile(context(), PROFILE_ID).body.evidenceAxes.signatureRelease).toBe("SOURCE_REPORTED_ONLY");
    expect(store.readProfile(context(), PROFILE_ID).body.evidenceAxes.deployment).toBe("NOT_RUN_ENV_UNAVAILABLE");
    expect(store.reportSignedBundle("source.bundle-distribution", envelope, NOW + 61).body).toEqual(accepted.body);
    expect(store.inboxCount()).toBe(1);
  });

  it.each([
    ["wrong authenticated source", (bundleId: string, digest: string) => ({ source: "source.not-allowed", envelope: signedEnvelope(bundleId, digest) })],
    ["wrong partition", (bundleId: string, digest: string) => ({ source: "source.bundle-distribution", envelope: signedEnvelope(bundleId, digest, { partitionKey: "tenant.wrong" }) })],
    ["wrong tenant", (bundleId: string, digest: string) => ({ source: "source.bundle-distribution", envelope: signedEnvelope(bundleId, digest, { organizationId: "tenant.22222222222242228222222222222222", partitionKey: "tenant.22222222222242228222222222222222" }) })],
    ["wrong profile digest", (bundleId: string, _digest: string) => ({ source: "source.bundle-distribution", envelope: signedEnvelope(bundleId, `sha256:${"0".repeat(64)}`) })],
    ["wrong sequence", (bundleId: string, digest: string) => ({ source: "source.bundle-distribution", envelope: signedEnvelope(bundleId, digest, { sequence: 2 }) })],
    ["stale observation", (bundleId: string, digest: string) => ({ source: "source.bundle-distribution", envelope: signedEnvelope(bundleId, digest, { observedAt: "2026-05-28T20:00:00Z" }) })],
  ] as const)("refuses %s without a partial inbox or operation transition", (_name, variant) => {
    const { store, operations } = system();
    const requested = requestBundle(store);
    const profileDigest = store.readProfile(context(), PROFILE_ID).body.reviewDigest;
    const candidate = variant(requested.body.id, profileDigest);
    expect(() => store.reportSignedBundle(candidate.source, candidate.envelope, NOW + 60)).toThrow();
    expect(store.inboxCount()).toBe(0);
    expect(store.readBundle(context(), requested.body.id).body.state).toBe("REQUESTED");
    expect(operations.outboxEvents(context().organizationId)).toHaveLength(0);
  });

  it("rejects non-SIGNED source status and rolls back when status audit persistence fails", () => {
    const fixture = system();
    const requested = requestBundle(fixture.store);
    const digest = fixture.store.readProfile(context(), PROFILE_ID).body.reviewDigest;
    const valid = signedEnvelope(requested.body.id, digest);
    const invalid = signedEnvelope(requested.body.id, digest, {
      release: { ...valid.release, spec: { ...valid.release.spec, state: "BUILT" } } as never,
    });
    expect(() => fixture.store.reportSignedBundle(SOURCE_ID, invalid, NOW + 60)).toThrowError("BUNDLE_RELEASE_REFUSED");
    expect(fixture.store.readBundle(context(), requested.body.id).body.state).toBe("REQUESTED");

    fixture.store.failNextAuditForTest();
    expect(() => fixture.store.reportSignedBundle(SOURCE_ID, valid, NOW + 60)).toThrowError("AUDIT_WRITE_REFUSED");
    expect(fixture.store.readBundle(context(), requested.body.id).body.operation.spec.state).toBe("PENDING");
    expect(fixture.store.inboxCount()).toBe(0);
  });
});
