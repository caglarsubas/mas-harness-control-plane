import { canonicalJson, sha256 } from "../../apps/control-web/src/lib/foundation/canonical";
import type { TenantContext } from "../../apps/control-web/src/lib/foundation/contracts";
import type { DemandProjection } from "../../apps/control-web/src/lib/demands/contracts";
import type { CompileInputResolution } from "../../apps/control-web/src/lib/operations/contracts";
import { OperationStore } from "../../apps/control-web/src/lib/operations/service";
import type { AdmittedProfilePolicy, BundleReleaseResource, DistributionStatusEnvelope, OutputName } from "../../apps/control-web/src/lib/profiles/contracts";
import { InMemoryProfileApprovalPolicy } from "../../apps/control-web/src/lib/profiles/dependencies";
import { ProfileLifecycleStore, profileMutationFingerprint } from "../../apps/control-web/src/lib/profiles/service";

export const NOW = 1_780_272_000;
export const ORGANIZATION_A = "11111111-1111-4111-8111-111111111111";
export const ORGANIZATION_B = "22222222-2222-4222-8222-222222222222";
export const REQUESTER = `sha256:${"1".repeat(64)}`;
export const REVIEWER_ONE = `sha256:${"2".repeat(64)}`;
export const REVIEWER_TWO = `sha256:${"3".repeat(64)}`;
export const SOURCE_ID = "source.bundle-distribution";
export const PROFILE_ID = "profile.enterprise-target";

export function context(subjectDigest = REQUESTER, organizationId = ORGANIZATION_A): TenantContext {
  return Object.freeze({
    schemaVersion: "planeon.control.foundation/v1",
    organizationId,
    subjectDigest,
    sessionId: "session.fixture",
    admissionDigest: `sha256:${"a".repeat(64)}`,
    issuedAt: "2026-05-29T00:00:00Z",
    expiresAt: "2026-05-30T00:00:00Z",
  });
}

function operations(): OperationStore {
  return new OperationStore(
    { readDemand(_context: TenantContext, _id: string): { status: number; body: DemandProjection; etag: string } { throw new Error("unused"); } },
    { resolve(_organizationId: string, _demand: DemandProjection): CompileInputResolution { return Object.freeze({ availability: "UNAVAILABLE" }); } },
  );
}

function bytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

export function compiledOutputs(proposedSelectors: readonly unknown[] = []): Readonly<Record<OutputName, Uint8Array>> {
  const profileDocument = {
    schemaVersion: "harness.planeon.ai/compiled-profile-document/v1alpha1",
    tenantDemand: { apiVersion: "harness.planeon.ai/v1alpha1", kind: "TenantDemand", metadata: { id: "demand.enterprise", version: "0.1.0" }, spec: {} },
    profile: {
      apiVersion: "harness.planeon.ai/v1alpha1",
      kind: "HarnessProfile",
      metadata: { id: PROFILE_ID, version: "0.1.0" },
      spec: {
        state: "PLANNED",
        tenantId: "tenant.11111111111141118111111111111111",
        catalogDigest: `sha256:${"c".repeat(64)}`,
        tenantDemandId: "demand.enterprise",
        readinessAssessmentId: "readiness.enterprise",
        readinessStatus: "READY",
        requestedCapabilities: ["capability.domain-semantic"],
        directHarnessIds: ["knowledge.domain-semantic"],
        selectedHarnessIds: ["knowledge.domain-semantic", "knowledge.data-integration"],
        acceptedPrerequisiteHarnessIds: ["knowledge.data-integration"],
        selectedModuleIds: ["module.knowledge.domain-semantic.core", "module.knowledge.data-integration.core"],
        selectedProviderIds: ["provider.runtime.infrastructure.local"],
        providerSelections: [],
        proposedSelectors,
        assuranceSubjects: { harnessIds: [], capabilityIds: [] },
        executionBudgetId: "budget.enterprise",
        environmentAttestationDigest: `sha256:${"e".repeat(64)}`,
      },
    },
    executionBudget: { apiVersion: "harness.planeon.ai/v1alpha1", kind: "ExecutionBudget", metadata: { id: "budget.enterprise", version: "0.1.0" }, spec: {} },
  };
  const profileBytes = bytes(profileDocument);
  return Object.freeze({
    "profile.json": profileBytes,
    "bom.json": bytes({ apiVersion: "harness.planeon.ai/v1alpha1", kind: "BillOfMaterials", items: [] }),
    "install-plan.json": bytes({ apiVersion: "harness.planeon.ai/v1alpha1", kind: "InstallPlan", steps: [] }),
    "evidence-plan.json": bytes({ apiVersion: "harness.planeon.ai/v1alpha1", kind: "EvidencePlan", axes: [] }),
    "explanation.md": Buffer.from("# Enterprise target\n\nTwo named knowledge harnesses are selected.\n", "utf8"),
    "profile.sha256": Buffer.from(`${sha256(profileBytes)}\n`, "ascii"),
  });
}

export function profilePolicy(expiresAt = "2026-06-01T01:00:00Z"): AdmittedProfilePolicy {
  return Object.freeze({
    disposition: "ADMITTED",
    policyRef: Object.freeze({ kind: "approval-policy", id: "policy.profile-review", digest: `sha256:${"b".repeat(64)}` }),
    requiredDecisions: 2,
    eligibleReviewerDigests: Object.freeze([REVIEWER_ONE, REVIEWER_TWO]),
    expiresAt,
    requesterMayReview: false,
  });
}

export function system(proposedSelectors: readonly unknown[] = [], expiresAt?: string): { readonly store: ProfileLifecycleStore; readonly operations: OperationStore } {
  const operationStore = operations();
  const store = new ProfileLifecycleStore(new InMemoryProfileApprovalPolicy(profilePolicy(expiresAt)), operationStore, new Set([SOURCE_ID]));
  const outputs = compiledOutputs(proposedSelectors);
  const outputDigests = Object.freeze(Object.fromEntries(Object.entries(outputs).map(([name, value]) => [name, sha256(value)]))) as Readonly<Record<OutputName, string>>;
  const demandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const demandDigest = `sha256:${"d".repeat(64)}`;
  const compilerWheelDigest = `sha256:${"5".repeat(64)}`;
  const catalogDigest = `sha256:${"c".repeat(64)}`;
  store.registerCompiledProfile({
    organizationId: ORGANIZATION_A,
    profileId: PROFILE_ID,
    profileRevision: 1,
    resultKey: sha256(canonicalJson({ binding: [ORGANIZATION_A, demandId, 7, demandDigest, compilerWheelDigest, catalogDigest], profileDigest: outputDigests["profile.json"] })),
    demandId,
    demandRevision: 7,
    demandDigest,
    compilerWheelDigest,
    catalogDigest,
    outputs,
    outputDigests,
    createdAt: "2026-05-29T00:00:00Z",
  });
  return { store, operations: operationStore };
}

export function requestApproval(store: ProfileLifecycleStore) {
  const profile = store.readProfile(context(), PROFILE_ID);
  const path = `/api/v1alpha1/profiles/${PROFILE_ID}/approve`;
  return store.requestApproval(context(), PROFILE_ID, profile.etag, "profile-approval-request-001", profileMutationFingerprint("POST", path, {}), NOW);
}

export function approveProfile(store: ProfileLifecycleStore) {
  let approval = requestApproval(store);
  const path = `/api/v1alpha1/profiles/${PROFILE_ID}/approval/decision`;
  const firstBody = { decision: "APPROVE" as const, reasonCode: "REVIEW_COMPLETE" };
  approval = store.decide(context(REVIEWER_ONE), PROFILE_ID, firstBody, approval.etag, "profile-reviewer-one-001", profileMutationFingerprint("POST", path, firstBody), NOW + 10);
  const secondBody = { decision: "APPROVE" as const, reasonCode: "REVIEW_COMPLETE" };
  return store.decide(context(REVIEWER_TWO), PROFILE_ID, secondBody, approval.etag, "profile-reviewer-two-001", profileMutationFingerprint("POST", path, secondBody), NOW + 20);
}

export function lockProfile(store: ProfileLifecycleStore) {
  approveProfile(store);
  const profile = store.readProfile(context(), PROFILE_ID);
  const path = `/api/v1alpha1/profiles/${PROFILE_ID}/lock`;
  return store.lock(context(), PROFILE_ID, profile.etag, "profile-lock-request-001", profileMutationFingerprint("POST", path, {}), NOW + 30);
}

export function requestBundle(store: ProfileLifecycleStore) {
  lockProfile(store);
  const profile = store.readProfile(context(), PROFILE_ID);
  const body = { profileId: PROFILE_ID };
  return store.requestBundle(context(), PROFILE_ID, profile.etag, "profile-bundle-request-001", profileMutationFingerprint("POST", "/api/v1alpha1/bundles", body), NOW + 40);
}

export function signedRelease(profileDigest: string): BundleReleaseResource {
  return Object.freeze({
    apiVersion: "harness.planeon.ai/v1alpha1",
    kind: "BundleRelease",
    metadata: Object.freeze({ id: "release.enterprise-target", version: "0.1.0" }),
    spec: Object.freeze({
      organizationId: "tenant.11111111111141118111111111111111",
      state: "SIGNED",
      profileDigest,
      bundleDigest: `sha256:${"4".repeat(64)}`,
      releaseDigest: `sha256:${"6".repeat(64)}`,
      manifestDigest: `sha256:${"7".repeat(64)}`,
      signatureDigest: `sha256:${"8".repeat(64)}`,
      supersedesReleaseDigest: null,
      reasonCode: null,
    }),
  });
}

export function signedEnvelope(bundleId: string, profileDigest: string, overrides: Partial<DistributionStatusEnvelope> = {}): DistributionStatusEnvelope {
  return Object.freeze({
    sourceId: SOURCE_ID,
    organizationId: "tenant.11111111111141118111111111111111",
    partitionKey: "tenant.11111111111141118111111111111111",
    eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    bundleRequestId: bundleId,
    sequence: 1,
    observedAt: "2026-06-01T00:01:00Z",
    release: signedRelease(profileDigest),
    ...overrides,
  });
}
