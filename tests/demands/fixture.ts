import { FOUNDATION_SCHEMA, type TenantContext } from "../../apps/control-web/src/lib/foundation/contracts";
import type {
  AdmittedApprovalPolicy,
  DemandCreateInput,
  ResolvedDemandSource,
  StoredResponse,
  DemandProjection,
} from "../../apps/control-web/src/lib/demands/contracts";
import { FixedApprovalPolicyHook, InMemoryDemandSourceResolver } from "../../apps/control-web/src/lib/demands/dependencies";
import { DemandApprovalStore, mutationFingerprint } from "../../apps/control-web/src/lib/demands/service";

export const NOW = Date.parse("2026-06-01T00:00:00Z") / 1000;
export const ORGANIZATION_A = "11111111-1111-4111-8111-111111111111";
export const ORGANIZATION_B = "22222222-2222-4222-8222-222222222222";
export const QUESTIONNAIRE_SESSION = "33333333-3333-4333-8333-333333333333";
export const REQUESTER_DIGEST = `sha256:${"a".repeat(64)}`;
export const REVIEWER_ONE_DIGEST = `sha256:${"b".repeat(64)}`;
export const REVIEWER_TWO_DIGEST = `sha256:${"c".repeat(64)}`;
export const OUTSIDER_DIGEST = `sha256:${"d".repeat(64)}`;

export function context(subjectDigest = REQUESTER_DIGEST, organizationId = ORGANIZATION_A): TenantContext {
  const suffix = subjectDigest.slice(-12);
  return Object.freeze({
    schemaVersion: FOUNDATION_SCHEMA,
    organizationId,
    subjectDigest,
    sessionId: organizationId === ORGANIZATION_A
      ? `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`
      : `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
    admissionDigest: `sha256:${"e".repeat(64)}`,
    issuedAt: "2026-06-01T00:00:00Z",
    expiresAt: "2026-06-01T08:00:00Z",
  });
}

export function source(overrides: Partial<ResolvedDemandSource> = {}): ResolvedDemandSource {
  return Object.freeze({
    organizationId: ORGANIZATION_A,
    questionnaireSessionId: QUESTIONNAIRE_SESSION,
    questionnaireSessionRevision: 12,
    questionnaireState: "READY_FOR_COMPILATION",
    questionnaireAnswerSetId: "answer-set.white-goods",
    questionnaireAnswerSetDigest: `sha256:${"1".repeat(64)}`,
    readinessAssessmentId: "readiness.white-goods",
    readinessAssessmentDigest: `sha256:${"2".repeat(64)}`,
    readinessStatus: "PASS",
    readinessExpiresAt: "2026-06-02T00:00:00Z",
    ownerApprovalId: "owner-approval.manufacturing",
    ownerApprovalDigest: `sha256:${"3".repeat(64)}`,
    ownerApprovalExpiresAt: "2026-06-02T00:00:00Z",
    environmentAttestationDigest: `sha256:${"4".repeat(64)}`,
    ...overrides,
  });
}

export function input(overrides: Partial<DemandCreateInput> = {}): DemandCreateInput {
  const resolved = source();
  return Object.freeze({
    source: Object.freeze({
      questionnaireSessionId: resolved.questionnaireSessionId,
      questionnaireSessionRevision: resolved.questionnaireSessionRevision,
      questionnaireAnswerSetId: resolved.questionnaireAnswerSetId,
      questionnaireAnswerSetDigest: resolved.questionnaireAnswerSetDigest,
      readinessAssessmentId: resolved.readinessAssessmentId,
      readinessAssessmentDigest: resolved.readinessAssessmentDigest,
    }),
    requestedCapabilities: Object.freeze(["data.integration", "domain.semantic"]),
    proposedPrerequisiteHarnessIds: Object.freeze(["knowledge.data-integration", "knowledge.domain-semantic"]),
    prerequisiteDecisions: Object.freeze([
      Object.freeze({ harnessId: "knowledge.data-integration", decision: "ACCEPT", reasonCode: "TENANT_ACCEPTED" }),
      Object.freeze({ harnessId: "knowledge.domain-semantic", decision: "ACCEPT", reasonCode: "TENANT_ACCEPTED" }),
    ]),
    environment: Object.freeze({
      deploymentMode: "self-managed",
      architecture: "arm64",
      operatingSystem: "linux",
      kubernetesDistribution: "openshift",
      capabilities: Object.freeze(["network.local-only"]),
      attestationDigest: resolved.environmentAttestationDigest,
      signatureStatus: "VERIFIED",
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
    ...overrides,
  });
}

export function policy(overrides: Partial<AdmittedApprovalPolicy> = {}): AdmittedApprovalPolicy {
  return Object.freeze({
    disposition: "ADMITTED",
    policyRef: Object.freeze({ kind: "policy.demand-approval", id: "policy.white-goods", digest: `sha256:${"5".repeat(64)}` }),
    requiredDecisions: 2,
    eligibleReviewerDigests: Object.freeze([REVIEWER_ONE_DIGEST, REVIEWER_TWO_DIGEST]),
    expiresAt: "2026-06-01T02:00:00Z",
    requesterMayReview: false,
    ...overrides,
  });
}

export function system(options: {
  readonly resolvedSource?: ResolvedDemandSource;
  readonly policyResult?: ReturnType<typeof policy> | { readonly disposition: "DENIED" | "UNAVAILABLE" };
} = {}) {
  const sources = new InMemoryDemandSourceResolver();
  sources.register(options.resolvedSource ?? source());
  const policies = new FixedApprovalPolicyHook();
  policies.set(ORGANIZATION_A, options.policyResult ?? policy());
  return { sources, policies, store: new DemandApprovalStore(sources, policies) };
}

export function createValidated(
  store: DemandApprovalStore,
  tenant = context(),
  demandInput = input(),
  now = NOW,
): StoredResponse<DemandProjection> {
  const createPath = "/api/v1alpha1/demands";
  const created = store.create(tenant, demandInput, "create-demand-fixture-001", mutationFingerprint("POST", createPath, demandInput), now);
  const validatePath = `/api/v1alpha1/demands/${created.body.id}/validate`;
  return store.validate(tenant, created.body.id, created.etag, "validate-demand-fixture-001", mutationFingerprint("POST", validatePath, {}), now + 1);
}

export function errorCode(action: () => unknown): string {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof Error && "code" in error ? String(error.code) : "UNEXPECTED_ERROR";
  }
}
