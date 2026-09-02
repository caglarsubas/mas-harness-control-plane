import { describe, expect, it } from "vitest";

import { FOUNDATION_SCHEMA, type TenantContext } from "../apps/control-web/src/lib/foundation/contracts";
import { JOURNEY_STAGES, type TenantAnswer } from "../apps/control-web/src/lib/questionnaire/contracts";
import { admitIndustryPack, AdmittedIndustryPackRegistry } from "../apps/control-web/src/lib/questionnaire/pack";
import { mutationFingerprint, QuestionnaireSessionStore } from "../apps/control-web/src/lib/questionnaire/session";
import { buildSignedPackFixture } from "../tests/questionnaire/fixture";

const NOW = Date.parse("2026-06-01T00:00:00Z") / 1000;

describe("questionnaire-to-readiness local journey", () => {
  it("saves, refreshes, resumes, and reviews all eight stages without external services", () => {
    const fixture = buildSignedPackFixture();
    const pack = admitIndustryPack(fixture.envelope, fixture.archive, fixture.registry, NOW);
    const registry = new AdmittedIndustryPackRegistry();
    registry.admit(pack);
    const store = new QuestionnaireSessionStore(registry);
    const tenant: TenantContext = {
      schemaVersion: FOUNDATION_SCHEMA,
      organizationId: "11111111-1111-4111-8111-111111111111",
      subjectDigest: `sha256:${"a".repeat(64)}`,
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      admissionDigest: `sha256:${"b".repeat(64)}`,
      issuedAt: "2026-06-01T00:00:00Z",
      expiresAt: "2026-06-01T08:00:00Z",
    };
    const createInput = { packId: pack.packId, packVersion: pack.packVersion };
    let mutation = store.create(tenant, createInput, "e2e-create-001", mutationFingerprint("POST", "/api/v1alpha1/sessions", createInput), NOW);
    const values: Record<string, TenantAnswer["value"]> = {
      owner: "Enterprise sponsor",
      outcome: "quality",
      "observation-count": 500,
      "policy-approved": true,
      "integration-boundary": "Approved local source boundary",
      harnesses: ["domain-semantic", "data-integration"],
      environment: "kubernetes",
      "evidence-separated": true,
    };
    for (const [index, stage] of pack.stages.entries()) {
      const input = {
        stageId: stage.id,
        answers: stage.questions.map((question): TenantAnswer => ({ questionId: question.id, value: values[question.id], source: "TENANT_DECLARATION" })),
      };
      const path = `/api/v1alpha1/sessions/${mutation.body.id}/answers`;
      mutation = store.saveAnswers(tenant, mutation.body.id, input, mutation.etag, `e2e-save-${index + 1}-001`, mutationFingerprint("PUT", path, input), NOW + index + 1);
      const refreshed = store.read(tenant, mutation.body.id);
      expect(refreshed.etag).toBe(mutation.etag);
      expect(refreshed.body.revision).toBe(index + 2);
    }
    expect(mutation.body.completedStageIds).toEqual(JOURNEY_STAGES.map((stage) => stage.id));
    const reviewPath = `/api/v1alpha1/sessions/${mutation.body.id}/review`;
    const reviewed = store.review(tenant, mutation.body.id, mutation.etag, "e2e-review-001", mutationFingerprint("POST", reviewPath, {}), NOW + 20);
    expect(reviewed.body.state).toBe("READY_FOR_COMPILATION");
    expect(reviewed.body.findings.at(-1)?.reasonCode).toBe("QUESTIONNAIRE_COMPLETE");
  });
});
