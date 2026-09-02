import { describe, expect, it } from "vitest";

import { DEMAND_CONTRACT_AUTHORITY } from "../../apps/control-web/src/lib/demands/contracts";
import { mutationFingerprint } from "../../apps/control-web/src/lib/demands/service";
import {
  NOW,
  ORGANIZATION_B,
  context,
  createValidated,
  errorCode,
  input,
  source,
  system,
} from "./fixture";

describe("CTRL-003 demand contracts", () => {
  it("pins the exact TenantDemand, ApprovalRequest, and lifecycle authority", () => {
    expect(DEMAND_CONTRACT_AUTHORITY).toEqual({
      repository: "caglarsubas/mas-harness-contracts",
      commit: "2146278a95344cd2a8e22596b2f315b46edffc88",
      releaseManifestSha256: "c5dd4c39d1c69d07f8d8de3d1a09584bb906172fee2d5ac20ad25ff344b0db79",
      tenantDemandSha256: "c43620c47e3afee6b2be09b1cc80c6b9ef9d851d1930f57531aa1e56a98373f2",
      approvalRequestSha256: "4fe8d214a920690008a4390919acebf797b0ab4e6c649a7a88e0882f3b2a1b27",
      lifecycleTransitionsSha256: "17122d47f3d3cce568f117b9113f83821db3aaddba3c910afb40e068f193dffc",
    });
  });

  it("derives an exact tenant demand from accepted prerequisites and server tenant context", () => {
    const { store } = system();
    const validated = createValidated(store);
    expect(validated.body.state).toBe("VALIDATED");
    expect(validated.body.revision).toBe(2);
    expect(validated.body.validatedResourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(validated.body.tenantDemand).toMatchObject({
      apiVersion: "harness.planeon.ai/v1alpha1",
      kind: "TenantDemand",
      spec: {
        tenantId: "tenant.11111111111141118111111111111111",
        acceptedPrerequisiteHarnessIds: ["knowledge.data-integration", "knowledge.domain-semantic"],
        questionnaireAnswerSetId: "answer-set.white-goods",
        readinessAssessmentId: "readiness.white-goods",
      },
    });
    expect(validated.body.findings.at(-1)?.reasonCode).toBe("DEMAND_VALIDATED");
    expect(store.prerequisiteDecisionRecords(context(), validated.body.id)).toHaveLength(2);
  });

  it("requires one closed explicit decision for every proposed prerequisite", () => {
    const invalid = [
      input({ prerequisiteDecisions: [input().prerequisiteDecisions[0]] }),
      input({ prerequisiteDecisions: [input().prerequisiteDecisions[0], input().prerequisiteDecisions[0]] }),
      input({ prerequisiteDecisions: [
        ...input().prerequisiteDecisions,
        { harnessId: "knowledge.memory-state", decision: "ACCEPT", reasonCode: "TENANT_ACCEPTED" },
      ] }),
    ];
    for (const [index, candidate] of invalid.entries()) {
      const { store } = system();
      expect(errorCode(() => store.create(
        context(), candidate, `invalid-decision-${index}-001`, mutationFingerprint("POST", "/api/v1alpha1/demands", candidate), NOW,
      ))).toBe("PREREQUISITE_DECISION_SET_REFUSED");
    }
  });

  it("retains explicit rejection as a deterministic blocker", () => {
    const rejected = input({
      prerequisiteDecisions: [
        input().prerequisiteDecisions[0],
        { harnessId: "knowledge.domain-semantic", decision: "REJECT", reasonCode: "TENANT_REJECTED" },
      ],
    });
    const { store } = system();
    const result = createValidated(store, context(), rejected);
    expect(result.body.state).toBe("BLOCKED");
    expect(result.body.tenantDemand.spec.acceptedPrerequisiteHarnessIds).toEqual(["knowledge.data-integration"]);
    expect(result.body.findings.some((finding) => finding.reasonCode === "PREREQUISITE_REJECTED")).toBe(true);
  });

  it("blocks unavailable, mismatched, stale, non-PASS, and unowned source evidence", () => {
    const cases = [
      source({ questionnaireState: "BLOCKED" }),
      source({ readinessStatus: "WARN" }),
      source({ readinessExpiresAt: "2026-05-31T23:59:59Z" }),
      source({ ownerApprovalId: null, ownerApprovalDigest: null, ownerApprovalExpiresAt: null }),
      source({ ownerApprovalExpiresAt: "2026-05-31T23:59:59Z" }),
      source({ environmentAttestationDigest: `sha256:${"9".repeat(64)}` }),
      source({ questionnaireAnswerSetDigest: `sha256:${"8".repeat(64)}` }),
    ];
    for (const resolvedSource of cases) {
      const { store } = system({ resolvedSource });
      expect(createValidated(store).body.state).toBe("BLOCKED");
    }
    const unavailable = system();
    unavailable.sources.setUnavailableForTest(true);
    expect(createValidated(unavailable.store).body.findings.some((finding) => finding.reasonCode === "SOURCE_UNAVAILABLE")).toBe(true);
  });

  it("enforces ETag, idempotency, lifecycle, and tenant-indistinguishable lookup", () => {
    const { store } = system();
    const demandInput = input();
    const fingerprint = mutationFingerprint("POST", "/api/v1alpha1/demands", demandInput);
    const created = store.create(context(), demandInput, "demand-replay-001", fingerprint, NOW);
    expect(store.create(context(), demandInput, "demand-replay-001", fingerprint, NOW + 1)).toEqual(created);
    expect(errorCode(() => store.create(
      context(), demandInput, "demand-replay-001", mutationFingerprint("POST", "/api/v1alpha1/demands", { changed: true }), NOW + 1,
    ))).toBe("IDEMPOTENCY_KEY_CONFLICT");
    const path = `/api/v1alpha1/demands/${created.body.id}/validate`;
    expect(errorCode(() => store.validate(context(), created.body.id, null, "missing-etag-001", mutationFingerprint("POST", path, {}), NOW + 1))).toBe("IF_MATCH_REQUIRED");
    const validated = store.validate(context(), created.body.id, created.etag, "valid-demand-001", mutationFingerprint("POST", path, {}), NOW + 1);
    expect(errorCode(() => store.validate(context(), created.body.id, created.etag, "stale-demand-001", mutationFingerprint("POST", path, {}), NOW + 2))).toBe("ETAG_PRECONDITION_FAILED");
    expect(errorCode(() => store.validate(context(), validated.body.id, validated.etag, "illegal-demand-001", mutationFingerprint("POST", path, {}), NOW + 2))).toBe("DEMAND_VALIDATION_STATE_REFUSED");
    expect(errorCode(() => store.readDemand(context(undefined, ORGANIZATION_B), created.body.id))).toBe("DEMAND_NOT_FOUND");
    expect(errorCode(() => store.readDemand(context(), "44444444-4444-4444-8444-444444444444"))).toBe("DEMAND_NOT_FOUND");
  });
});
