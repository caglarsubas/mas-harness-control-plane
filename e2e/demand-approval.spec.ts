import { describe, expect, it } from "vitest";

import { mutationFingerprint } from "../apps/control-web/src/lib/demands/service";
import {
  NOW,
  REVIEWER_ONE_DIGEST,
  REVIEWER_TWO_DIGEST,
  context,
  createValidated,
  system,
} from "../tests/demands/fixture";

describe("local demand-to-approval journey", () => {
  it("keeps accepted prerequisites explicit and reaches approval only through two distinct reviewers", () => {
    const { store } = system();
    const validated = createValidated(store);
    expect(validated.body.state).toBe("VALIDATED");
    expect(validated.body.tenantDemand.spec.acceptedPrerequisiteHarnessIds).toEqual([
      "knowledge.data-integration",
      "knowledge.domain-semantic",
    ]);

    const approvePath = `/api/v1alpha1/demands/${validated.body.id}/approve`;
    const requested = store.requestApproval(
      context(), validated.body.id, validated.etag, "e2e-approval-request-001", mutationFingerprint("POST", approvePath, {}), NOW + 2,
    );
    const decisionPath = `/api/v1alpha1/approvals/${requested.body.id}/decision`;
    const decision = { decision: "APPROVE" as const, reasonCode: "REVIEW_COMPLETE" };
    const first = store.decide(
      context(REVIEWER_ONE_DIGEST), requested.body.id, decision, requested.etag,
      "e2e-reviewer-one-001", mutationFingerprint("POST", decisionPath, decision), NOW + 3,
    );
    expect(first.body.state).toBe("PENDING");
    const second = store.decide(
      context(REVIEWER_TWO_DIGEST), requested.body.id, decision, first.etag,
      "e2e-reviewer-two-001", mutationFingerprint("POST", decisionPath, decision), NOW + 4,
    );
    expect(second.body.state).toBe("APPROVED");
    expect(store.readDemand(context(), validated.body.id).body.state).toBe("APPROVED");
  });
});
