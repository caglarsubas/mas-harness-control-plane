import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../apps/control-web/src/lib/foundation/canonical";
import type { TenantContext } from "../../apps/control-web/src/lib/foundation/contracts";
import type { AdmittedIndustryPack, StageId, TenantAnswer } from "../../apps/control-web/src/lib/questionnaire/contracts";
import { admitIndustryPack, AdmittedIndustryPackRegistry } from "../../apps/control-web/src/lib/questionnaire/pack";
import { mutationFingerprint as questionnaireFingerprint, QuestionnaireSessionStore } from "../../apps/control-web/src/lib/questionnaire/session";
import { FixedApprovalPolicyHook, InMemoryDemandSourceResolver } from "../../apps/control-web/src/lib/demands/dependencies";
import type { DemandCreateInput, DemandProjection, ResolvedDemandSource } from "../../apps/control-web/src/lib/demands/contracts";
import { DemandApprovalStore, mutationFingerprint as demandFingerprint } from "../../apps/control-web/src/lib/demands/service";
import { InMemoryCompileInputResolver } from "../../apps/control-web/src/lib/operations/dependencies";
import { OperationStore, operationMutationFingerprint } from "../../apps/control-web/src/lib/operations/service";
import type { OutputName } from "../../apps/control-web/src/lib/profiles/contracts";
import { InMemoryProfileApprovalPolicy } from "../../apps/control-web/src/lib/profiles/dependencies";
import { ProfileLifecycleStore, profileMutationFingerprint } from "../../apps/control-web/src/lib/profiles/service";
import { verifyAuditChain } from "../../apps/control-web/src/lib/security/audit-chain";
import { buildSignedPackFixture } from "../questionnaire/fixture";
import {
  NOW,
  ORGANIZATION_A,
  ORGANIZATION_B,
  REVIEWER_ONE_DIGEST,
  REVIEWER_TWO_DIGEST,
  context,
  policy,
} from "../demands/fixture";
import {
  PROFILE_ID,
  REQUESTER,
  REVIEWER_ONE,
  REVIEWER_TWO,
  compiledOutputs,
  profilePolicy,
} from "../profiles/fixture";

const ANSWERS: Readonly<Record<string, TenantAnswer["value"]>> = Object.freeze({
  owner: "White-goods manufacturing owner",
  outcome: "quality",
  "observation-count": 1200,
  "policy-approved": true,
  "integration-boundary": "Local MES read-only integration",
  harnesses: Object.freeze(["domain-semantic", "data-integration", "governance"]),
  environment: "openshift",
  "evidence-separated": true,
});

function answers(pack: AdmittedIndustryPack, stageId: StageId): TenantAnswer[] {
  return pack.stages.find((stage) => stage.id === stageId)!.questions.map((question) => Object.freeze({
    questionId: question.id,
    value: ANSWERS[question.id]!,
    source: "TENANT_DECLARATION" as const,
  }));
}

function demandInput(source: ResolvedDemandSource): DemandCreateInput {
  return Object.freeze({
    source: Object.freeze({
      questionnaireSessionId: source.questionnaireSessionId,
      questionnaireSessionRevision: source.questionnaireSessionRevision,
      questionnaireAnswerSetId: source.questionnaireAnswerSetId,
      questionnaireAnswerSetDigest: source.questionnaireAnswerSetDigest,
      readinessAssessmentId: source.readinessAssessmentId,
      readinessAssessmentDigest: source.readinessAssessmentDigest,
    }),
    requestedCapabilities: Object.freeze(["data.integration", "domain.semantic"]),
    proposedPrerequisiteHarnessIds: Object.freeze(["knowledge.data-integration", "knowledge.domain-semantic"]),
    prerequisiteDecisions: Object.freeze([
      Object.freeze({ harnessId: "knowledge.data-integration", decision: "ACCEPT" as const, reasonCode: "TENANT_ACCEPTED" }),
      Object.freeze({ harnessId: "knowledge.domain-semantic", decision: "ACCEPT" as const, reasonCode: "TENANT_ACCEPTED" }),
    ]),
    environment: Object.freeze({
      deploymentMode: "self-managed" as const,
      architecture: "arm64" as const,
      operatingSystem: "linux",
      kubernetesDistribution: "openshift",
      capabilities: Object.freeze(["network.local-only"]),
      attestationDigest: source.environmentAttestationDigest,
      signatureStatus: "VERIFIED" as const,
    }),
    assuranceSubjects: Object.freeze({
      harnessIds: Object.freeze(["knowledge.data-integration", "knowledge.domain-semantic"]),
      capabilityIds: Object.freeze(["data.integration", "domain.semantic"]),
    }),
    executionBudget: Object.freeze({
      maxConcurrentTasks: 4,
      maxTaskSeconds: 900,
      maxRetries: 2,
      maxToolCalls: 20,
      maxModelTokens: 120_000,
    }),
  });
}

function profileContext(subjectDigest = REQUESTER, organizationId = ORGANIZATION_A): TenantContext {
  return Object.freeze({ ...context(subjectDigest, organizationId), subjectDigest });
}

describe("complete white-goods service journey", () => {
  it("moves declared intent to one locked profile and bundle request while preserving evidence limits", () => {
    const signedPack = buildSignedPackFixture();
    const pack = admitIndustryPack(signedPack.envelope, signedPack.archive, signedPack.registry, NOW);
    const packRegistry = new AdmittedIndustryPackRegistry();
    packRegistry.admit(pack);
    const questionnaire = new QuestionnaireSessionStore(packRegistry);
    const tenant = context();
    const createBody = { packId: pack.packId, packVersion: pack.packVersion };
    let session = questionnaire.create(
      tenant,
      createBody,
      "white-goods-session-001",
      questionnaireFingerprint("POST", "/api/v1alpha1/sessions", createBody),
      NOW,
    );
    for (const [index, stage] of pack.stages.entries()) {
      const body = { stageId: stage.id, answers: answers(pack, stage.id) };
      session = questionnaire.saveAnswers(
        tenant,
        session.body.id,
        body,
        session.etag,
        `white-goods-stage-${String(index + 1).padStart(3, "0")}`,
        questionnaireFingerprint("PUT", `/api/v1alpha1/sessions/${session.body.id}/answers`, body),
        NOW + index + 1,
      );
    }
    const ready = questionnaire.review(
      tenant,
      session.body.id,
      session.etag,
      "white-goods-review-001",
      questionnaireFingerprint("POST", `/api/v1alpha1/sessions/${session.body.id}/review`, {}),
      NOW + 10,
    );
    expect(ready.body.state).toBe("READY_FOR_COMPILATION");

    const resolved: ResolvedDemandSource = Object.freeze({
      organizationId: ORGANIZATION_A,
      questionnaireSessionId: ready.body.id,
      questionnaireSessionRevision: ready.body.revision,
      questionnaireState: ready.body.state,
      questionnaireAnswerSetId: `answer-set.${ready.body.id}`,
      questionnaireAnswerSetDigest: sha256(canonicalJson(ready.body.answers)),
      readinessAssessmentId: `readiness.${ready.body.id}`,
      readinessAssessmentDigest: sha256(canonicalJson(ready.body.findings)),
      readinessStatus: "PASS",
      readinessExpiresAt: "2026-06-02T00:00:00Z",
      ownerApprovalId: "owner-approval.white-goods",
      ownerApprovalDigest: `sha256:${"3".repeat(64)}`,
      ownerApprovalExpiresAt: "2026-06-02T00:00:00Z",
      environmentAttestationDigest: `sha256:${"4".repeat(64)}`,
    });
    const sources = new InMemoryDemandSourceResolver();
    sources.register(resolved);
    const policies = new FixedApprovalPolicyHook();
    policies.set(ORGANIZATION_A, policy());
    const demands = new DemandApprovalStore(sources, policies);
    const input = demandInput(resolved);
    let demand = demands.create(
      tenant,
      input,
      "white-goods-demand-001",
      demandFingerprint("POST", "/api/v1alpha1/demands", input),
      NOW + 11,
    );
    demand = demands.validate(
      tenant,
      demand.body.id,
      demand.etag,
      "white-goods-validate-001",
      demandFingerprint("POST", `/api/v1alpha1/demands/${demand.body.id}/validate`, {}),
      NOW + 12,
    );
    const approval = demands.requestApproval(
      tenant,
      demand.body.id,
      demand.etag,
      "white-goods-demand-approval-001",
      demandFingerprint("POST", `/api/v1alpha1/demands/${demand.body.id}/approve`, {}),
      NOW + 13,
    );
    const decision = { decision: "APPROVE" as const, reasonCode: "REVIEW_COMPLETE" };
    const first = demands.decide(
      context(REVIEWER_ONE_DIGEST), approval.body.id, decision, approval.etag,
      "white-goods-demand-reviewer-one-001",
      demandFingerprint("POST", `/api/v1alpha1/approvals/${approval.body.id}/decision`, decision), NOW + 14,
    );
    demands.decide(
      context(REVIEWER_TWO_DIGEST), approval.body.id, decision, first.etag,
      "white-goods-demand-reviewer-two-001",
      demandFingerprint("POST", `/api/v1alpha1/approvals/${approval.body.id}/decision`, decision), NOW + 15,
    );
    const approvedDemand = demands.readDemand(tenant, demand.body.id);
    expect(approvedDemand.body.state).toBe("APPROVED");

    const compileInputs = new InMemoryCompileInputResolver();
    compileInputs.register({
      organizationId: ORGANIZATION_A,
      demandId: approvedDemand.body.id,
      demandRevision: approvedDemand.body.revision,
      demandDigest: approvedDemand.body.digest,
      questionnaireAnswerSetId: resolved.questionnaireAnswerSetId,
      questionnaireAnswerSetDigest: resolved.questionnaireAnswerSetDigest,
      readinessAssessmentId: resolved.readinessAssessmentId,
      readinessAssessmentDigest: resolved.readinessAssessmentDigest,
      environmentAttestationDigest: resolved.environmentAttestationDigest,
      compileRequest: Object.freeze({ metadata: Object.freeze({ tenantId: approvedDemand.body.tenantDemand.spec.tenantId, demandId: approvedDemand.body.tenantDemand.metadata.id }) }),
      catalogResources: Object.freeze([Object.freeze({ kind: "HarnessClassDefinition" })]),
      catalogDigest: `sha256:${"c".repeat(64)}`,
    });
    const operations = new OperationStore(demands, compileInputs);
    const compile = operations.requestCompilation(
      tenant,
      approvedDemand.body.id,
      approvedDemand.etag,
      "white-goods-compile-001",
      operationMutationFingerprint("POST", `/api/v1alpha1/demands/${approvedDemand.body.id}/compile`, {}),
      NOW + 16,
    );
    operations.applyWorkerTransition(ORGANIZATION_A, compile.body.metadata.id, "RUNNING", "COMPILATION_STARTED", NOW + 17);
    operations.applyWorkerTransition(
      ORGANIZATION_A,
      compile.body.metadata.id,
      "SUCCEEDED",
      "COMPILATION_SUCCEEDED",
      NOW + 18,
      [{ kind: "harness-profile", id: PROFILE_ID, digest: `sha256:${"9".repeat(64)}` }],
    );

    const profiles = new ProfileLifecycleStore(new InMemoryProfileApprovalPolicy(profilePolicy()), operations);
    const outputs = compiledOutputs();
    const outputDigests = Object.freeze(Object.fromEntries(Object.entries(outputs).map(([name, value]) => [name, sha256(value)]))) as Readonly<Record<OutputName, string>>;
    const compilerWheelDigest = `sha256:${"5".repeat(64)}`;
    const catalogDigest = `sha256:${"c".repeat(64)}`;
    profiles.registerCompiledProfile({
      organizationId: ORGANIZATION_A,
      profileId: PROFILE_ID,
      profileRevision: 1,
      resultKey: sha256(canonicalJson({
        binding: [ORGANIZATION_A, approvedDemand.body.id, approvedDemand.body.revision, approvedDemand.body.digest, compilerWheelDigest, catalogDigest],
        profileDigest: outputDigests["profile.json"],
      })),
      demandId: approvedDemand.body.id,
      demandRevision: approvedDemand.body.revision,
      demandDigest: approvedDemand.body.digest,
      compilerWheelDigest,
      catalogDigest,
      outputs,
      outputDigests,
      createdAt: "2026-06-01T00:00:19Z",
    });
    let profile = profiles.readProfile(profileContext(), PROFILE_ID);
    const profileApproval = profiles.requestApproval(
      profileContext(), PROFILE_ID, profile.etag, "white-goods-profile-approval-001",
      profileMutationFingerprint("POST", `/api/v1alpha1/profiles/${PROFILE_ID}/approve`, {}), NOW + 20,
    );
    const profileDecision = { decision: "APPROVE" as const, reasonCode: "REVIEW_COMPLETE" };
    const profileFirst = profiles.decide(
      profileContext(REVIEWER_ONE), PROFILE_ID, profileDecision, profileApproval.etag,
      "white-goods-profile-reviewer-one-001",
      profileMutationFingerprint("POST", `/api/v1alpha1/profiles/${PROFILE_ID}/approval/decision`, profileDecision), NOW + 21,
    );
    profiles.decide(
      profileContext(REVIEWER_TWO), PROFILE_ID, profileDecision, profileFirst.etag,
      "white-goods-profile-reviewer-two-001",
      profileMutationFingerprint("POST", `/api/v1alpha1/profiles/${PROFILE_ID}/approval/decision`, profileDecision), NOW + 22,
    );
    profile = profiles.readProfile(profileContext(), PROFILE_ID);
    profiles.lock(
      profileContext(), PROFILE_ID, profile.etag, "white-goods-profile-lock-001",
      profileMutationFingerprint("POST", `/api/v1alpha1/profiles/${PROFILE_ID}/lock`, {}), NOW + 23,
    );
    profile = profiles.readProfile(profileContext(), PROFILE_ID);
    const bundleBody = { profileId: PROFILE_ID };
    const bundle = profiles.requestBundle(
      profileContext(), PROFILE_ID, profile.etag, "white-goods-bundle-001",
      profileMutationFingerprint("POST", "/api/v1alpha1/bundles", bundleBody), NOW + 24,
    );
    expect(bundle.body.state).toBe("REQUESTED");
    expect(bundle.body.operation.spec.state).toBe("PENDING");
    expect(profiles.readProfile(profileContext(), PROFILE_ID).body.evidenceAxes).toEqual({
      source: "PASS",
      contractUnit: "PASS",
      artifactSbom: "MISSING",
      signatureRelease: "MISSING",
      deployment: "NOT_RUN_ENV_UNAVAILABLE",
      runtime: "NOT_RUN_ENV_UNAVAILABLE",
      security: "NOT_RUN_ENV_UNAVAILABLE",
      assurance: "MISSING",
      tenantAcceptance: "MISSING",
    });

    expect(() => questionnaire.read(context(undefined, ORGANIZATION_B), ready.body.id)).toThrowError("QUESTIONNAIRE_SESSION_NOT_FOUND");
    expect(() => demands.readDemand(context(undefined, ORGANIZATION_B), approvedDemand.body.id)).toThrowError("DEMAND_NOT_FOUND");
    expect(() => operations.readOperation(context(undefined, ORGANIZATION_B), compile.body.metadata.id)).toThrowError("OPERATION_NOT_FOUND");
    expect(() => profiles.readProfile(profileContext(undefined, ORGANIZATION_B), PROFILE_ID)).toThrowError("PROFILE_NOT_FOUND");
    for (const [organizationId, records] of [
      [ORGANIZATION_A, questionnaire.auditChainRecords(tenant)],
      [ORGANIZATION_A, demands.auditChainRecords(tenant)],
      [ORGANIZATION_A, operations.auditChainRecords(ORGANIZATION_A)],
      [ORGANIZATION_A, profiles.auditChainRecords(ORGANIZATION_A)],
    ] as const) {
      expect(records.length).toBeGreaterThan(0);
      expect(verifyAuditChain(organizationId, records).valid).toBe(true);
    }
  });
});
