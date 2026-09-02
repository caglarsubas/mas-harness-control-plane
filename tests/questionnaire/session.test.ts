import { describe, expect, it } from "vitest";

import type { TenantContext } from "../../apps/control-web/src/lib/foundation/contracts";
import { ControlError } from "../../apps/control-web/src/lib/foundation/contracts";
import { FOUNDATION_SCHEMA } from "../../apps/control-web/src/lib/foundation/contracts";
import type { AdmittedIndustryPack, StageId, TenantAnswer } from "../../apps/control-web/src/lib/questionnaire/contracts";
import { admitIndustryPack, AdmittedIndustryPackRegistry } from "../../apps/control-web/src/lib/questionnaire/pack";
import { mutationFingerprint, QuestionnaireSessionStore } from "../../apps/control-web/src/lib/questionnaire/session";
import { buildSignedPackFixture } from "./fixture";

const NOW = Date.parse("2026-06-01T00:00:00Z") / 1000;
const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

function context(organizationId: string): TenantContext {
  return Object.freeze({
    schemaVersion: FOUNDATION_SCHEMA,
    organizationId,
    subjectDigest: `sha256:${(organizationId === TENANT_A ? "a" : "b").repeat(64)}`,
    sessionId: organizationId,
    admissionDigest: `sha256:${"c".repeat(64)}`,
    issuedAt: "2026-06-01T00:00:00Z",
    expiresAt: "2026-06-01T08:00:00Z",
  });
}

function system(): { pack: AdmittedIndustryPack; store: QuestionnaireSessionStore } {
  const fixture = buildSignedPackFixture();
  const pack = admitIndustryPack(fixture.envelope, fixture.archive, fixture.registry, NOW);
  const packs = new AdmittedIndustryPackRegistry();
  packs.admit(pack);
  return { pack, store: new QuestionnaireSessionStore(packs) };
}

function errorCode(action: () => unknown): string {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof ControlError ? error.code : "UNEXPECTED_ERROR";
  }
}

const values: Record<string, TenantAnswer["value"]> = {
  owner: "Manufacturing excellence sponsor",
  outcome: "quality",
  "observation-count": 1200,
  "policy-approved": true,
  "integration-boundary": "Local MES read-only integration",
  harnesses: ["domain-semantic", "data-integration", "governance"],
  environment: "openshift",
  "evidence-separated": true,
};

function stageAnswers(pack: AdmittedIndustryPack, stageId: StageId): TenantAnswer[] {
  const stage = pack.stages.find((candidate) => candidate.id === stageId)!;
  return stage.questions.map((question) => ({
    questionId: question.id,
    value: values[question.id],
    source: "TENANT_DECLARATION",
  }));
}

describe("tenant-isolated questionnaire state machine", () => {
  it("creates DRAFT, blocks incomplete review, resumes through eight stages, and becomes ready deterministically", () => {
    const { pack, store } = system();
    const tenant = context(TENANT_A);
    const createBody = { packId: pack.packId, packVersion: pack.packVersion };
    const created = store.create(tenant, createBody, "create-session-001", mutationFingerprint("POST", "/api/v1alpha1/sessions", createBody), NOW);
    expect(created.status).toBe(201);
    expect(created.body.state).toBe("DRAFT");
    expect(created.body.revision).toBe(1);
    expect(created.body.currentStageId).toBe("business-context");

    const blockedFingerprint = mutationFingerprint("POST", `/api/v1alpha1/sessions/${created.body.id}/review`, {});
    const blocked = store.review(tenant, created.body.id, created.etag, "review-blocked-001", blockedFingerprint, NOW + 1);
    expect(blocked.body.state).toBe("BLOCKED");
    expect(blocked.body.findings.filter((finding) => finding.revision === 2 && finding.severity === "BLOCKING")).toHaveLength(8);

    let current = blocked;
    for (const [index, stage] of pack.stages.entries()) {
      const input = { stageId: stage.id, answers: stageAnswers(pack, stage.id) };
      const path = `/api/v1alpha1/sessions/${created.body.id}/answers`;
      current = store.saveAnswers(
        tenant,
        created.body.id,
        input,
        current.etag,
        `save-stage-${String(index + 1).padStart(3, "0")}`,
        mutationFingerprint("PUT", path, input),
        NOW + index + 2,
      );
      expect(current.body.state).toBe("IN_PROGRESS");
    }
    expect(current.body.completedStageIds).toHaveLength(8);
    const readyFingerprint = mutationFingerprint("POST", `/api/v1alpha1/sessions/${created.body.id}/review`, {});
    const ready = store.review(tenant, created.body.id, current.etag, "review-ready-001", readyFingerprint, NOW + 20);
    expect(ready.body.state).toBe("READY_FOR_COMPILATION");
    expect(ready.body.findings.at(-1)?.reasonCode).toBe("QUESTIONNAIRE_COMPLETE");
    expect(store.answerRevisions(tenant, created.body.id)).toHaveLength(8);
    expect(store.auditEvents(tenant, created.body.id)).toHaveLength(11);

    const replay = store.review(tenant, created.body.id, current.etag, "review-ready-001", readyFingerprint, NOW + 30);
    expect(replay).toEqual(ready);
    expect(store.auditEvents(tenant, created.body.id)).toHaveLength(11);
  });

  it("enforces replay, conflict, strong ETag, and tenant-indistinguishable not-found semantics", () => {
    const { pack, store } = system();
    const tenant = context(TENANT_A);
    const other = context(TENANT_B);
    const createBody = { packId: pack.packId, packVersion: pack.packVersion };
    const fingerprint = mutationFingerprint("POST", "/api/v1alpha1/sessions", createBody);
    const created = store.create(tenant, createBody, "create-replay-001", fingerprint, NOW);
    expect(store.create(tenant, createBody, "create-replay-001", fingerprint, NOW + 1)).toEqual(created);
    expect(errorCode(() => store.create(
      tenant,
      createBody,
      "create-replay-001",
      mutationFingerprint("POST", "/api/v1alpha1/sessions", { ...createBody, changed: true }),
      NOW + 1,
    ))).toBe("IDEMPOTENCY_KEY_CONFLICT");

    const input = { stageId: "business-context" as const, answers: stageAnswers(pack, "business-context") };
    const path = `/api/v1alpha1/sessions/${created.body.id}/answers`;
    expect(errorCode(() => store.saveAnswers(tenant, created.body.id, input, null, "missing-etag-001", mutationFingerprint("PUT", path, input), NOW + 2))).toBe("IF_MATCH_REQUIRED");
    const saved = store.saveAnswers(tenant, created.body.id, input, created.etag, "valid-save-001", mutationFingerprint("PUT", path, input), NOW + 2);
    expect(errorCode(() => store.saveAnswers(tenant, created.body.id, input, created.etag, "stale-etag-001", mutationFingerprint("PUT", path, input), NOW + 3))).toBe("ETAG_PRECONDITION_FAILED");
    expect(saved.body.revision).toBe(2);
    expect(errorCode(() => store.read(other, created.body.id))).toBe("QUESTIONNAIRE_SESSION_NOT_FOUND");
    expect(errorCode(() => store.read(tenant, "33333333-3333-4333-8333-333333333333"))).toBe("QUESTIONNAIRE_SESSION_NOT_FOUND");
  });

  it("rejects credential-shaped, wrong-source, type, and closed-choice values without appending a revision", () => {
    const { pack, store } = system();
    const tenant = context(TENANT_A);
    const createBody = { packId: pack.packId, packVersion: pack.packVersion };
    const created = store.create(tenant, createBody, "create-validation-001", mutationFingerprint("POST", "/api/v1alpha1/sessions", createBody), NOW);
    const path = `/api/v1alpha1/sessions/${created.body.id}/answers`;
    const cases: readonly [string, TenantAnswer[] | Record<string, unknown>[], string][] = [
      ["credential", [{ questionId: "owner", value: "password=do-not-store", source: "TENANT_DECLARATION" }], "QUESTIONNAIRE_CREDENTIAL_VALUE_REFUSED"],
      ["type", [{ questionId: "owner", value: 42, source: "TENANT_DECLARATION" }], "QUESTIONNAIRE_ANSWER_TYPE_REFUSED"],
      ["choice", [{ questionId: "outcome", value: "unlisted", source: "TENANT_DECLARATION" }], "QUESTIONNAIRE_CHOICE_REFUSED"],
      ["source", [{ questionId: "owner", value: "Owner", source: "LLM_GENERATED" }], "QUESTIONNAIRE_ANSWER_SET_REFUSED"],
    ];
    for (const [name, answers, expected] of cases) {
      const stageId = name === "choice" ? "domain-and-outcomes" : "business-context";
      const input = { stageId: stageId as StageId, answers: answers as TenantAnswer[] };
      expect(errorCode(() => store.saveAnswers(tenant, created.body.id, input, created.etag, `invalid-${name}-001`, mutationFingerprint("PUT", path, input), NOW + 1))).toBe(expected);
    }
    expect(store.read(tenant, created.body.id).body.revision).toBe(1);
    expect(store.answerRevisions(tenant, created.body.id)).toHaveLength(0);
  });

  it("commits session mutation, append-only history, and audit atomically", () => {
    const { pack, store } = system();
    const tenant = context(TENANT_A);
    const createBody = { packId: pack.packId, packVersion: pack.packVersion };
    const created = store.create(tenant, createBody, "create-atomic-001", mutationFingerprint("POST", "/api/v1alpha1/sessions", createBody), NOW);
    const input = { stageId: "business-context" as const, answers: stageAnswers(pack, "business-context") };
    const path = `/api/v1alpha1/sessions/${created.body.id}/answers`;
    store.failNextAuditForTest();
    expect(errorCode(() => store.saveAnswers(tenant, created.body.id, input, created.etag, "atomic-save-001", mutationFingerprint("PUT", path, input), NOW + 1))).toBe("AUDIT_APPEND_FAILED");
    expect(store.read(tenant, created.body.id).body.revision).toBe(1);
    expect(store.answerRevisions(tenant, created.body.id)).toHaveLength(0);
    expect(store.auditEvents(tenant, created.body.id)).toHaveLength(1);
  });
});
