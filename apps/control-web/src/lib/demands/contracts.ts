export const DEMAND_SCHEMA = "planeon.control.demand/v1alpha1" as const;
export const HARNESS_API_VERSION = "harness.planeon.ai/v1alpha1" as const;

export const DEMAND_CONTRACT_AUTHORITY = Object.freeze({
  repository: "caglarsubas/mas-harness-contracts",
  commit: "2146278a95344cd2a8e22596b2f315b46edffc88",
  releaseManifestSha256: "c5dd4c39d1c69d07f8d8de3d1a09584bb906172fee2d5ac20ad25ff344b0db79",
  tenantDemandSha256: "c43620c47e3afee6b2be09b1cc80c6b9ef9d851d1930f57531aa1e56a98373f2",
  approvalRequestSha256: "4fe8d214a920690008a4390919acebf797b0ab4e6c649a7a88e0882f3b2a1b27",
  lifecycleTransitionsSha256: "17122d47f3d3cce568f117b9113f83821db3aaddba3c910afb40e068f193dffc",
});

export type DemandState =
  | "DRAFT"
  | "BLOCKED"
  | "VALIDATED"
  | "APPROVAL_PENDING"
  | "APPROVED"
  | "REJECTED"
  | "SUPERSEDED";

export type ApprovalState = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";
export type PrerequisiteDecision = "ACCEPT" | "REJECT";
export type ReviewerDecision = "APPROVE" | "REJECT";

export interface ResourceMetadata {
  readonly id: string;
  readonly version: string;
}

export interface ResourceRef {
  readonly kind: string;
  readonly id: string;
  readonly digest: string;
}

export interface ActorRef {
  readonly type: "HUMAN";
  readonly id: string;
}

export interface EnvironmentInput {
  readonly deploymentMode: "operator-hosted-saas" | "tenant-public-cloud" | "self-managed" | "air-gapped";
  readonly architecture: "amd64" | "arm64" | "platform-supplied";
  readonly operatingSystem: "linux" | "macos" | "platform-supplied";
  readonly kubernetesDistribution: "upstream" | "k3s" | "openshift" | "none" | "platform-supplied";
  readonly capabilities: readonly string[];
  readonly attestationDigest: string;
  readonly signatureStatus: "VERIFIED";
}

export interface TenantDemandEnvironment extends EnvironmentInput {
  readonly tenantId: string;
}

export interface AssuranceSubjects {
  readonly harnessIds: readonly string[];
  readonly capabilityIds: readonly string[];
}

export interface ExecutionBudget {
  readonly maxConcurrentTasks: number;
  readonly maxTaskSeconds: number;
  readonly maxRetries: number;
  readonly maxToolCalls: number;
  readonly maxModelTokens: number;
}

export interface DemandSourceReference {
  readonly questionnaireSessionId: string;
  readonly questionnaireSessionRevision: number;
  readonly questionnaireAnswerSetId: string;
  readonly questionnaireAnswerSetDigest: string;
  readonly readinessAssessmentId: string;
  readonly readinessAssessmentDigest: string;
}

export interface ResolvedDemandSource extends DemandSourceReference {
  readonly organizationId: string;
  readonly questionnaireState: "DRAFT" | "IN_PROGRESS" | "BLOCKED" | "READY_FOR_COMPILATION" | "SUPERSEDED";
  readonly readinessStatus: "PASS" | "WARN" | "FAIL" | "STALE" | "NOT_RUN_ENV_UNAVAILABLE";
  readonly readinessExpiresAt: string;
  readonly ownerApprovalId: string | null;
  readonly ownerApprovalDigest: string | null;
  readonly ownerApprovalExpiresAt: string | null;
  readonly environmentAttestationDigest: string;
}

export type DemandSourceResolution =
  | { readonly availability: "AVAILABLE"; readonly source: ResolvedDemandSource }
  | { readonly availability: "NOT_FOUND" }
  | { readonly availability: "UNAVAILABLE" };

export interface DemandSourceResolver {
  resolve(organizationId: string, reference: DemandSourceReference): DemandSourceResolution;
}

export interface PrerequisiteDecisionInput {
  readonly harnessId: string;
  readonly decision: PrerequisiteDecision;
  readonly reasonCode: string;
}

export interface DemandCreateInput {
  readonly source: DemandSourceReference;
  readonly requestedCapabilities: readonly string[];
  readonly proposedPrerequisiteHarnessIds: readonly string[];
  readonly prerequisiteDecisions: readonly PrerequisiteDecisionInput[];
  readonly environment: EnvironmentInput;
  readonly assuranceSubjects: AssuranceSubjects;
  readonly executionBudget: ExecutionBudget;
}

export interface TenantDemandResource {
  readonly apiVersion: typeof HARNESS_API_VERSION;
  readonly kind: "TenantDemand";
  readonly metadata: ResourceMetadata;
  readonly spec: {
    readonly tenantId: string;
    readonly questionnaireAnswerSetId: string;
    readonly readinessAssessmentId: string;
    readonly requestedCapabilities: readonly string[];
    readonly acceptedPrerequisiteHarnessIds: readonly string[];
    readonly environment: TenantDemandEnvironment;
    readonly assuranceSubjects: AssuranceSubjects;
    readonly executionBudget: ExecutionBudget;
  };
}

export interface DemandFinding {
  readonly findingId: string;
  readonly demandId: string;
  readonly revision: number;
  readonly severity: "BLOCKING" | "PASS";
  readonly reasonCode:
    | "SOURCE_UNAVAILABLE"
    | "SOURCE_REFERENCE_MISMATCH"
    | "QUESTIONNAIRE_NOT_READY"
    | "READINESS_NOT_PASS"
    | "READINESS_EXPIRED"
    | "OWNER_APPROVAL_MISSING"
    | "OWNER_APPROVAL_EXPIRED"
    | "ENVIRONMENT_ATTESTATION_MISMATCH"
    | "PREREQUISITE_REJECTED"
    | "APPROVAL_EXPIRED"
    | "DEMAND_VALIDATED";
  readonly subjectId: string;
  readonly occurredAt: string;
}

export interface DemandProjection {
  readonly schemaVersion: typeof DEMAND_SCHEMA;
  readonly id: string;
  readonly state: DemandState;
  readonly revision: number;
  readonly digest: string;
  readonly validatedResourceDigest: string | null;
  readonly source: DemandSourceReference;
  readonly proposedPrerequisiteHarnessIds: readonly string[];
  readonly prerequisiteDecisions: readonly PrerequisiteDecisionInput[];
  readonly findings: readonly DemandFinding[];
  readonly tenantDemand: TenantDemandResource;
  readonly approvalId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PolicyAdmissionRequest {
  readonly organizationId: string;
  readonly requesterDigest: string;
  readonly demandId: string;
  readonly demandRevision: number;
  readonly demandDigest: string;
  readonly nowEpoch: number;
}

export interface AdmittedApprovalPolicy {
  readonly disposition: "ADMITTED";
  readonly policyRef: ResourceRef;
  readonly requiredDecisions: number;
  readonly eligibleReviewerDigests: readonly string[];
  readonly expiresAt: string;
  readonly requesterMayReview: false;
}

export type ApprovalPolicyResult =
  | AdmittedApprovalPolicy
  | { readonly disposition: "DENIED" }
  | { readonly disposition: "UNAVAILABLE" };

export interface ApprovalPolicyHook {
  evaluate(request: PolicyAdmissionRequest): ApprovalPolicyResult;
}

export interface ApprovalDecisionRecord {
  readonly actor: ActorRef;
  readonly actorDigest: string;
  readonly decision: ReviewerDecision;
  readonly decidedAt: string;
  readonly reasonCode: string;
}

export interface ApprovalRequestResource {
  readonly apiVersion: typeof HARNESS_API_VERSION;
  readonly kind: "ApprovalRequest";
  readonly metadata: ResourceMetadata;
  readonly spec: {
    readonly organizationId: string;
    readonly approvalType: "DEMAND";
    readonly state: ApprovalState;
    readonly subject: ResourceRef;
    readonly policyRef: ResourceRef;
    readonly requiredDecisions: number;
    readonly requestedBy: ActorRef;
    readonly requestedAt: string;
    readonly expiresAt: string;
    readonly decisions: readonly Omit<ApprovalDecisionRecord, "actorDigest">[];
    readonly reasonCode: string | null;
  };
}

export interface ApprovalProjection {
  readonly schemaVersion: typeof DEMAND_SCHEMA;
  readonly id: string;
  readonly demandId: string;
  readonly demandRevision: number;
  readonly demandDigest: string;
  readonly state: ApprovalState;
  readonly revision: number;
  readonly digest: string;
  readonly eligibleReviewerCount: number;
  readonly approvedDecisionCount: number;
  readonly resource: ApprovalRequestResource;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DemandAuditEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly actorDigest: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateDigest: string;
  readonly occurredAt: string;
}

export interface StoredResponse<T> {
  readonly status: number;
  readonly body: T;
  readonly etag: string;
}
