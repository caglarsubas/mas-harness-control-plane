import type { TenantContext } from "../foundation/contracts";
import type { ApprovalDecisionRecord, ApprovalState, ResourceRef, StoredResponse } from "../demands/contracts";
import type { OperationResource } from "../operations/contracts";

export const PROFILE_REVIEW_SCHEMA = "planeon.control.profile-review/v1alpha1" as const;
export const HARNESS_API_VERSION = "harness.planeon.ai/v1alpha1" as const;
export const PROFILE_CONTRACT_AUTHORITY = Object.freeze({
  repository: "caglarsubas/mas-harness-contracts",
  commit: "2146278a95344cd2a8e22596b2f315b46edffc88",
  releaseManifestSha256: "c5dd4c39d1c69d07f8d8de3d1a09584bb906172fee2d5ac20ad25ff344b0db79",
  harnessProfileSchemaSha256: "08936914f52b8c3b611e47ffa35f668dd177718f613907687a67b448877c39a6",
  compiledProfileDocumentSchemaSha256: "2b3b3d70a7fe00ca5667634622b0fafa22562f0a33f363663e27757aaa57bfcb",
  approvalRequestSchemaSha256: "4fe8d214a920690008a4390919acebf797b0ab4e6c649a7a88e0882f3b2a1b27",
  bundleReleaseSchemaSha256: "c983a8d97c70d7957e74f06413ca0158e3b7be626468bf8d217dfc5829aa5918",
});

export const OUTPUT_NAMES = Object.freeze([
  "profile.json",
  "bom.json",
  "install-plan.json",
  "evidence-plan.json",
  "explanation.md",
  "profile.sha256",
] as const);

export type OutputName = typeof OUTPUT_NAMES[number];
export type ProfileState = "PROPOSED" | "APPROVAL_PENDING" | "LOCKED" | "REJECTED" | "SUPERSEDED";
export type BundleRequestState = "REQUESTED" | "SOURCE_REPORTED_SIGNED";

export interface CompiledProfileRegistration {
  readonly organizationId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly resultKey: string;
  readonly demandId: string;
  readonly demandRevision: number;
  readonly demandDigest: string;
  readonly compilerWheelDigest: string;
  readonly catalogDigest: string;
  readonly outputs: Readonly<Record<OutputName, Uint8Array>>;
  readonly outputDigests: Readonly<Record<OutputName, string>>;
  readonly createdAt: string;
}

export interface OutputSummary {
  readonly digest: string;
  readonly byteLength: number;
}

export interface ProfileProjection {
  readonly schemaVersion: typeof PROFILE_REVIEW_SCHEMA;
  readonly id: string;
  readonly state: ProfileState;
  readonly revision: number;
  readonly resultKey: string;
  readonly reviewDigest: string;
  readonly demand: { readonly id: string; readonly revision: number; readonly digest: string };
  readonly compilerWheelDigest: string;
  readonly catalogDigest: string;
  readonly outputDigests: Readonly<Record<OutputName, string>>;
  readonly profile: Readonly<Record<string, unknown>>;
  readonly summaries: {
    readonly billOfMaterials: OutputSummary;
    readonly installPlan: OutputSummary;
    readonly evidencePlan: OutputSummary;
  };
  readonly approval: null | { readonly id: string; readonly state: ApprovalState; readonly digest: string };
  readonly lock: null | { readonly id: string; readonly digest: string; readonly lockedAt: string };
  readonly bundle: null | { readonly id: string; readonly state: BundleRequestState; readonly sourceFreshness: "SOURCE_UNAVAILABLE" | "CURRENT" | "STALE" };
  readonly evidenceAxes: {
    readonly source: "PASS";
    readonly contractUnit: "PASS";
    readonly artifactSbom: "MISSING";
    readonly signatureRelease: "MISSING" | "SOURCE_REPORTED_ONLY";
    readonly deployment: "NOT_RUN_ENV_UNAVAILABLE";
    readonly runtime: "NOT_RUN_ENV_UNAVAILABLE";
    readonly security: "NOT_RUN_ENV_UNAVAILABLE";
    readonly assurance: "MISSING";
    readonly tenantAcceptance: "MISSING";
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProfilePolicyAdmissionRequest {
  readonly organizationId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly resultKey: string;
  readonly reviewDigest: string;
  readonly requesterDigest: string;
  readonly requestedAt: string;
}

export interface AdmittedProfilePolicy {
  readonly disposition: "ADMITTED";
  readonly policyRef: ResourceRef;
  readonly requiredDecisions: number;
  readonly eligibleReviewerDigests: readonly string[];
  readonly expiresAt: string;
  readonly requesterMayReview: false;
}

export type ProfilePolicyResult = AdmittedProfilePolicy | { readonly disposition: "DENIED" } | { readonly disposition: "UNAVAILABLE" };

export interface ProfileApprovalPolicyHook {
  evaluate(request: ProfilePolicyAdmissionRequest): ProfilePolicyResult;
}

export interface ProfileApprovalResource {
  readonly apiVersion: typeof HARNESS_API_VERSION;
  readonly kind: "ApprovalRequest";
  readonly metadata: { readonly id: string; readonly version: string };
  readonly spec: {
    readonly organizationId: string;
    readonly approvalType: "PROFILE";
    readonly state: ApprovalState;
    readonly subject: ResourceRef;
    readonly policyRef: ResourceRef;
    readonly requiredDecisions: number;
    readonly requestedBy: { readonly type: "HUMAN"; readonly id: string };
    readonly requestedAt: string;
    readonly expiresAt: string;
    readonly decisions: readonly Omit<ApprovalDecisionRecord, "actorDigest">[];
    readonly reasonCode: string | null;
  };
}

export interface ProfileApprovalProjection {
  readonly schemaVersion: typeof PROFILE_REVIEW_SCHEMA;
  readonly id: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly resultKey: string;
  readonly reviewDigest: string;
  readonly state: ApprovalState;
  readonly revision: number;
  readonly digest: string;
  readonly policyDigest: string;
  readonly eligibleReviewerCount: number;
  readonly approvedDecisionCount: number;
  readonly resource: ProfileApprovalResource;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProfileLockProjection {
  readonly schemaVersion: typeof PROFILE_REVIEW_SCHEMA;
  readonly id: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly resultKey: string;
  readonly profileReviewDigest: string;
  readonly approvalId: string;
  readonly approvalRevision: number;
  readonly approvalDigest: string;
  readonly policyDigest: string;
  readonly digest: string;
  readonly lockedAt: string;
}

export interface BundleReleaseResource {
  readonly apiVersion: typeof HARNESS_API_VERSION;
  readonly kind: "BundleRelease";
  readonly metadata: { readonly id: string; readonly version: string };
  readonly spec: {
    readonly organizationId: string;
    readonly state: "SIGNED";
    readonly profileDigest: string;
    readonly bundleDigest: string;
    readonly releaseDigest: string;
    readonly manifestDigest: string;
    readonly signatureDigest: string;
    readonly supersedesReleaseDigest: string | null;
    readonly reasonCode: string | null;
  };
}

export interface DistributionStatusEnvelope {
  readonly sourceId: string;
  readonly organizationId: string;
  readonly partitionKey: string;
  readonly eventId: string;
  readonly bundleRequestId: string;
  readonly sequence: number;
  readonly observedAt: string;
  readonly release: BundleReleaseResource;
}

export interface BundleRequestProjection {
  readonly schemaVersion: typeof PROFILE_REVIEW_SCHEMA;
  readonly id: string;
  readonly state: BundleRequestState;
  readonly profileId: string;
  readonly profileLockDigest: string;
  readonly operation: OperationResource;
  readonly sourceFreshness: "SOURCE_UNAVAILABLE" | "CURRENT" | "STALE";
  readonly sourceId: string | null;
  readonly sourceSequence: number | null;
  readonly sourceObservedAt: string | null;
  readonly releaseRef: ResourceRef | null;
  readonly release: BundleReleaseResource | null;
  readonly requestedAt: string;
  readonly updatedAt: string;
  readonly evidenceBoundary: "SOURCE_REPORTED_ONLY";
}

export interface ProfileAuditEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateDigest: string;
  readonly actorDigest: string;
  readonly occurredAt: string;
}

export interface DigestOutboxRecord {
  readonly eventId: string;
  readonly organizationId: string;
  readonly eventType: "approval.requested.v1" | "profile.locked.v1" | "bundle.requested.v1";
  readonly aggregateId: string;
  readonly aggregateDigest: string;
  readonly occurredAt: string;
}

export interface ProfileRuntimeContract {
  readonly store: {
    readProfile(context: TenantContext, profileId: string): StoredResponse<ProfileProjection>;
  };
}
