import { describe, expect, it } from "vitest";

import { mutationFingerprint } from "../../apps/control-web/src/lib/demands/service";
import {
  NOW,
  ORGANIZATION_B,
  OUTSIDER_DIGEST,
  REQUESTER_DIGEST,
  REVIEWER_ONE_DIGEST,
  REVIEWER_TWO_DIGEST,
  context,
  createValidated,
  errorCode,
  input,
  policy,
  system,
} from "./fixture";

function approvalRequest(store: ReturnType<typeof system>["store"], now = NOW + 2) {
  const validated = createValidated(store);
  const path = `/api/v1alpha1/demands/${validated.body.id}/approve`;
  const approval = store.requestApproval(
    context(), validated.body.id, validated.etag, "request-approval-001", mutationFingerprint("POST", path, {}), now,
  );
  return { validated, approval };
}

describe("policy-admitted N-of-M demand approval", () => {
  it("records distinct approvals and completes the exact quorum", () => {
    const { store } = system();
    const { validated, approval } = approvalRequest(store);
    expect(approval.body.state).toBe("PENDING");
    expect(approval.body.resource.spec.approvalType).toBe("DEMAND");
    expect(approval.body.resource.spec.requiredDecisions).toBe(2);
    expect(store.readDemand(context(), validated.body.id).body.state).toBe("APPROVAL_PENDING");

    const path = `/api/v1alpha1/approvals/${approval.body.id}/decision`;
    const firstInput = { decision: "APPROVE" as const, reasonCode: "REVIEW_COMPLETE" };
    const first = store.decide(
      context(REVIEWER_ONE_DIGEST), approval.body.id, firstInput, approval.etag,
      "approval-decision-one-001", mutationFingerprint("POST", path, firstInput), NOW + 3,
    );
    expect(first.body.state).toBe("PENDING");
    expect(first.body.approvedDecisionCount).toBe(1);

    const secondInput = { decision: "APPROVE" as const, reasonCode: "REVIEW_COMPLETE" };
    const second = store.decide(
      context(REVIEWER_TWO_DIGEST), approval.body.id, secondInput, first.etag,
      "approval-decision-two-001", mutationFingerprint("POST", path, secondInput), NOW + 4,
    );
    expect(second.body.state).toBe("APPROVED");
    expect(second.body.resource.spec.reasonCode).toBe("QUORUM_REACHED");
    expect(second.body.resource.spec.decisions).toHaveLength(2);
    expect(JSON.stringify(second.body.resource)).not.toContain(REVIEWER_ONE_DIGEST);
    expect(store.readDemand(context(), validated.body.id).body.state).toBe("APPROVED");
    expect(store.demandAuditEvents(context(), validated.body.id).map((event) => event.eventType)).toEqual([
      "demand.created.v1", "demand.validated.v1", "demand.approval-pending.v1", "demand.approved.v1",
    ]);

    const replay = store.decide(
      context(REVIEWER_TWO_DIGEST), approval.body.id, secondInput, first.etag,
      "approval-decision-two-001", mutationFingerprint("POST", path, secondInput), NOW + 10,
    );
    expect(replay).toEqual(second);
    expect(errorCode(() => store.decide(
      context(OUTSIDER_DIGEST), approval.body.id, { decision: "APPROVE", reasonCode: "REVIEW_COMPLETE" }, second.etag,
      "terminal-approval-001", mutationFingerprint("POST", path, { decision: "APPROVE", reasonCode: "REVIEW_COMPLETE" }), NOW + 11,
    ))).toBe("APPROVAL_TERMINAL");
  });

  it("makes the first admitted rejection terminal without manufacturing acceptance", () => {
    const { store } = system();
    const { validated, approval } = approvalRequest(store);
    const path = `/api/v1alpha1/approvals/${approval.body.id}/decision`;
    const rejectedInput = { decision: "REJECT" as const, reasonCode: "REQUIREMENTS_REJECTED" };
    const rejected = store.decide(
      context(REVIEWER_ONE_DIGEST), approval.body.id, rejectedInput, approval.etag,
      "approval-reject-001", mutationFingerprint("POST", path, rejectedInput), NOW + 3,
    );
    expect(rejected.body.state).toBe("REJECTED");
    expect(rejected.body.resource.spec.reasonCode).toBe("REQUIREMENTS_REJECTED");
    expect(rejected.body.resource.spec.approvalType).not.toBe("TENANT_ACCEPTANCE");
    expect(store.readDemand(context(), validated.body.id).body.state).toBe("REJECTED");
  });

  it("rejects self, unauthorized, duplicate, and stale-reviewer mutations", () => {
    const { store } = system();
    const { approval } = approvalRequest(store);
    const path = `/api/v1alpha1/approvals/${approval.body.id}/decision`;
    const decision = { decision: "APPROVE" as const, reasonCode: "REVIEW_COMPLETE" };
    expect(errorCode(() => store.decide(
      context(REQUESTER_DIGEST), approval.body.id, decision, approval.etag,
      "self-review-001", mutationFingerprint("POST", path, decision), NOW + 3,
    ))).toBe("APPROVAL_SELF_REVIEW_REFUSED");
    expect(errorCode(() => store.decide(
      context(OUTSIDER_DIGEST), approval.body.id, decision, approval.etag,
      "outsider-review-001", mutationFingerprint("POST", path, decision), NOW + 3,
    ))).toBe("APPROVAL_REVIEWER_REFUSED");
    const first = store.decide(
      context(REVIEWER_ONE_DIGEST), approval.body.id, decision, approval.etag,
      "valid-review-001", mutationFingerprint("POST", path, decision), NOW + 3,
    );
    expect(errorCode(() => store.decide(
      context(REVIEWER_ONE_DIGEST), approval.body.id, decision, first.etag,
      "duplicate-review-001", mutationFingerprint("POST", path, decision), NOW + 4,
    ))).toBe("APPROVAL_DUPLICATE_REVIEWER");
    expect(errorCode(() => store.decide(
      context(REVIEWER_TWO_DIGEST), approval.body.id, decision, approval.etag,
      "stale-review-001", mutationFingerprint("POST", path, decision), NOW + 4,
    ))).toBe("ETAG_PRECONDITION_FAILED");
  });

  it("fails closed for unavailable, denied, malformed, and changed policy", () => {
    for (const disposition of ["UNAVAILABLE", "DENIED"] as const) {
      const { store } = system({ policyResult: { disposition } });
      const validated = createValidated(store);
      const path = `/api/v1alpha1/demands/${validated.body.id}/approve`;
      expect(errorCode(() => store.requestApproval(
        context(), validated.body.id, validated.etag, `policy-${disposition.toLowerCase()}-001`, mutationFingerprint("POST", path, {}), NOW + 2,
      ))).toBe(disposition === "UNAVAILABLE" ? "APPROVAL_POLICY_UNAVAILABLE" : "APPROVAL_POLICY_DENIED");
      expect(store.readDemand(context(), validated.body.id).body.state).toBe("VALIDATED");
    }

    const malformed = system();
    malformed.policies.set(ORGANIZATION_B, { disposition: "UNAVAILABLE" });
    malformed.policies.set("11111111-1111-4111-8111-111111111111", policy({ eligibleReviewerDigests: [REQUESTER_DIGEST, REVIEWER_ONE_DIGEST] }));
    const malformedDemand = createValidated(malformed.store);
    const malformedPath = `/api/v1alpha1/demands/${malformedDemand.body.id}/approve`;
    expect(errorCode(() => malformed.store.requestApproval(
      context(), malformedDemand.body.id, malformedDemand.etag, "malformed-policy-001", mutationFingerprint("POST", malformedPath, {}), NOW + 2,
    ))).toBe("APPROVAL_POLICY_REFUSED");

    const changed = system();
    const { approval } = approvalRequest(changed.store);
    changed.policies.set("11111111-1111-4111-8111-111111111111", policy({ requiredDecisions: 1 }));
    const decisionPath = `/api/v1alpha1/approvals/${approval.body.id}/decision`;
    const decision = { decision: "APPROVE" as const, reasonCode: "REVIEW_COMPLETE" };
    expect(errorCode(() => changed.store.decide(
      context(REVIEWER_ONE_DIGEST), approval.body.id, decision, approval.etag,
      "changed-policy-001", mutationFingerprint("POST", decisionPath, decision), NOW + 3,
    ))).toBe("APPROVAL_POLICY_STALE");
  });

  it("expires a stale request atomically and returns the exact replay", () => {
    const { store } = system({ policyResult: policy({ expiresAt: "2026-06-01T00:00:10Z" }) });
    const { validated, approval } = approvalRequest(store, NOW + 2);
    const path = `/api/v1alpha1/approvals/${approval.body.id}/decision`;
    const decision = { decision: "APPROVE" as const, reasonCode: "REVIEW_COMPLETE" };
    const expired = store.decide(
      context(REVIEWER_ONE_DIGEST), approval.body.id, decision, approval.etag,
      "expired-decision-001", mutationFingerprint("POST", path, decision), NOW + 10,
    );
    expect(expired.status).toBe(409);
    expect(expired.body.state).toBe("EXPIRED");
    const blocked = store.readDemand(context(), validated.body.id);
    expect(blocked.body.state).toBe("BLOCKED");
    expect(blocked.body.findings.at(-1)?.reasonCode).toBe("APPROVAL_EXPIRED");
    expect(store.decide(
      context(REVIEWER_ONE_DIGEST), approval.body.id, decision, approval.etag,
      "expired-decision-001", mutationFingerprint("POST", path, decision), NOW + 20,
    )).toEqual(expired);
  });

  it("keeps demand, approval, decisions, and audit atomic on audit failure", () => {
    const validationSystem = system();
    const demandInput = input();
    const created = validationSystem.store.create(
      context(), demandInput, "atomic-create-001", mutationFingerprint("POST", "/api/v1alpha1/demands", demandInput), NOW,
    );
    const validatePath = `/api/v1alpha1/demands/${created.body.id}/validate`;
    validationSystem.store.failNextAuditForTest();
    expect(errorCode(() => validationSystem.store.validate(
      context(), created.body.id, created.etag, "atomic-validate-001", mutationFingerprint("POST", validatePath, {}), NOW + 1,
    ))).toBe("AUDIT_APPEND_FAILED");
    expect(validationSystem.store.readDemand(context(), created.body.id).body.revision).toBe(1);

    const approvalSystem = system();
    const validated = createValidated(approvalSystem.store);
    const requestPath = `/api/v1alpha1/demands/${validated.body.id}/approve`;
    approvalSystem.store.failNextAuditForTest();
    expect(errorCode(() => approvalSystem.store.requestApproval(
      context(), validated.body.id, validated.etag, "atomic-approval-001", mutationFingerprint("POST", requestPath, {}), NOW + 2,
    ))).toBe("AUDIT_APPEND_FAILED");
    expect(approvalSystem.store.readDemand(context(), validated.body.id).body.state).toBe("VALIDATED");
  });

  it("returns indistinguishable not-found behavior across tenant boundaries", () => {
    const { store } = system();
    const { approval } = approvalRequest(store);
    expect(errorCode(() => store.readApproval(context(undefined, ORGANIZATION_B), approval.body.id))).toBe("APPROVAL_NOT_FOUND");
    expect(errorCode(() => store.readApproval(context(), "55555555-5555-4555-8555-555555555555"))).toBe("APPROVAL_NOT_FOUND");
  });
});
