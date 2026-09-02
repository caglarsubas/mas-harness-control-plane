import { randomUUID } from "node:crypto";

import { canonicalJson, parseJsonNoDuplicates, sha256 } from "../foundation/canonical";
import { ControlError, type TenantContext } from "../foundation/contracts";
import { TenantAuditChain, type AuditChainRecord } from "../security/audit-chain";
import type { ApprovalDecisionRecord, ApprovalState, ResourceRef, StoredResponse } from "../demands/contracts";
import type { OperationStore } from "../operations/service";
import type {
  AdmittedProfilePolicy,
  BundleReleaseResource,
  BundleRequestProjection,
  CompiledProfileRegistration,
  DigestOutboxRecord,
  DistributionStatusEnvelope,
  OutputName,
  ProfileApprovalPolicyHook,
  ProfileApprovalProjection,
  ProfileApprovalResource,
  ProfileAuditEvent,
  ProfileLockProjection,
  ProfileProjection,
  ProfileState,
} from "./contracts";
import { HARNESS_API_VERSION, OUTPUT_NAMES, PROFILE_REVIEW_SCHEMA } from "./contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u;
const REASON_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const RFC3339 = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const OUTPUT_SET = new Set<string>(OUTPUT_NAMES);

interface ProfileRow {
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
  readonly expectedOutputDigests: Readonly<Record<OutputName, string>>;
  readonly state: ProfileState;
  readonly revision: number;
  readonly approvalId: string | null;
  readonly lockId: string | null;
  readonly bundleRequestId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ApprovalRow {
  readonly id: string;
  readonly organizationId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly resultKey: string;
  readonly reviewDigest: string;
  readonly requesterDigest: string;
  readonly policy: AdmittedProfilePolicy;
  readonly policyDigest: string;
  readonly state: ApprovalState;
  readonly revision: number;
  readonly decisions: readonly ApprovalDecisionRecord[];
  readonly reasonCode: string | null;
  readonly requestedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface LockRow extends ProfileLockProjection {
  readonly organizationId: string;
}

interface BundleRow {
  readonly organizationId: string;
  readonly id: string;
  readonly state: "REQUESTED" | "SOURCE_REPORTED_SIGNED";
  readonly profileId: string;
  readonly profileReviewDigest: string;
  readonly profileLockDigest: string;
  readonly operation: BundleRequestProjection["operation"];
  readonly sourceId: string | null;
  readonly sourceSequence: number | null;
  readonly sourceObservedAt: string | null;
  readonly release: BundleReleaseResource | null;
  readonly releaseRef: ResourceRef | null;
  readonly requestedAt: string;
  readonly updatedAt: string;
}

interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly response: StoredResponse<unknown>;
}

interface VerifiedProfile {
  readonly document: Readonly<Record<string, unknown>>;
  readonly profile: Readonly<Record<string, unknown>>;
  readonly outputDigests: Readonly<Record<OutputName, string>>;
  readonly reviewDigest: string;
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ControlError(code, 422);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const accepted = new Set(keys);
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !accepted.has(key))) {
    throw new ControlError(code, 422);
  }
}

function timestamp(nowEpoch: number): string {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) throw new ControlError("PROFILE_TIME_REFUSED", 500);
  return new Date(nowEpoch * 1000).toISOString().replace(".000Z", "Z");
}

function epoch(value: string, code: string): number {
  if (!RFC3339.test(value)) throw new ControlError(code, 422);
  const parsed = Date.parse(value) / 1000;
  if (!Number.isSafeInteger(parsed)) throw new ControlError(code, 422);
  return parsed;
}

function tenantId(organizationId: string): string {
  return `tenant.${organizationId.replaceAll("-", "")}`;
}

function actorId(subjectDigest: string): string {
  return `actor.${subjectDigest.slice("sha256:".length)}`;
}

function assertContext(context: TenantContext, code = "PROFILE_NOT_FOUND"): void {
  if (!UUID.test(context.organizationId) || !SHA256.test(context.subjectDigest)) throw new ControlError(code, 404);
}

function immutableJson<T>(value: T): T {
  const clone = JSON.parse(canonicalJson(value)) as T;
  const freeze = (member: unknown): unknown => {
    if (member !== null && typeof member === "object") {
      for (const child of Object.values(member)) freeze(child);
      Object.freeze(member);
    }
    return member;
  };
  return freeze(clone) as T;
}

function decoded(bytes: Uint8Array, code: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ControlError(code, 409);
  }
}

function cloneOutputs(outputs: Readonly<Record<OutputName, Uint8Array>>): Readonly<Record<OutputName, Uint8Array>> {
  if (Object.keys(outputs).length !== OUTPUT_NAMES.length || Object.keys(outputs).some((name) => !OUTPUT_SET.has(name))) {
    throw new ControlError("PROFILE_OUTPUT_SET_REFUSED", 422);
  }
  return Object.freeze(Object.fromEntries(OUTPUT_NAMES.map((name) => [name, new Uint8Array(outputs[name])])) as Record<OutputName, Uint8Array>);
}

function verifyProfile(row: ProfileRow): VerifiedProfile {
  const outputDigests = Object.freeze(Object.fromEntries(
    OUTPUT_NAMES.map((name) => [name, sha256(row.outputs[name])]),
  ) as Record<OutputName, string>);
  if (OUTPUT_NAMES.some((name) => outputDigests[name] !== row.expectedOutputDigests[name])) {
    throw new ControlError("PROFILE_REVISION_TAMPERED", 409);
  }
  const profileChecksum = decoded(row.outputs["profile.sha256"], "PROFILE_REVISION_TAMPERED").trim();
  if (profileChecksum !== outputDigests["profile.json"]) throw new ControlError("PROFILE_REVISION_TAMPERED", 409);
  let parsed: unknown;
  try {
    parsed = parseJsonNoDuplicates(decoded(row.outputs["profile.json"], "PROFILE_REVISION_TAMPERED"), 1_048_576);
  } catch {
    throw new ControlError("PROFILE_REVISION_TAMPERED", 409);
  }
  const document = object(parsed, "PROFILE_REVISION_TAMPERED");
  exact(document, ["schemaVersion", "tenantDemand", "profile", "executionBudget"], "PROFILE_REVISION_TAMPERED");
  if (document.schemaVersion !== "harness.planeon.ai/compiled-profile-document/v1alpha1") {
    throw new ControlError("PROFILE_REVISION_TAMPERED", 409);
  }
  const profile = object(document.profile, "PROFILE_REVISION_TAMPERED");
  exact(profile, ["apiVersion", "kind", "metadata", "spec"], "PROFILE_REVISION_TAMPERED");
  const metadata = object(profile.metadata, "PROFILE_REVISION_TAMPERED");
  const spec = object(profile.spec, "PROFILE_REVISION_TAMPERED");
  if (
    profile.apiVersion !== HARNESS_API_VERSION || profile.kind !== "HarnessProfile" ||
    metadata.id !== row.profileId || spec.state !== "PLANNED" || spec.catalogDigest !== row.catalogDigest ||
    !Array.isArray(spec.proposedSelectors)
  ) {
    throw new ControlError("PROFILE_REVISION_TAMPERED", 409);
  }
  const reviewDigest = sha256(canonicalJson({
    organizationId: row.organizationId,
    profileId: row.profileId,
    profileRevision: row.profileRevision,
    resultKey: row.resultKey,
    demand: { id: row.demandId, revision: row.demandRevision, digest: row.demandDigest },
    compilerWheelDigest: row.compilerWheelDigest,
    catalogDigest: row.catalogDigest,
    outputDigests,
  }));
  return Object.freeze({
    document: immutableJson(document),
    profile: immutableJson(profile),
    outputDigests,
    reviewDigest,
  });
}

function policyDigest(policy: AdmittedProfilePolicy): string {
  return sha256(canonicalJson({
    policyRef: policy.policyRef,
    requiredDecisions: policy.requiredDecisions,
    eligibleReviewerDigests: [...policy.eligibleReviewerDigests].sort(),
    expiresAt: policy.expiresAt,
    requesterMayReview: policy.requesterMayReview,
  }));
}

function validatePolicy(value: AdmittedProfilePolicy, requesterDigest: string, nowEpoch: number): AdmittedProfilePolicy {
  if (
    value.disposition !== "ADMITTED" || value.requesterMayReview !== false ||
    !Number.isSafeInteger(value.requiredDecisions) || value.requiredDecisions < 1 || value.requiredDecisions > 32 ||
    value.eligibleReviewerDigests.length < value.requiredDecisions || value.eligibleReviewerDigests.length > 32 ||
    !STABLE_ID.test(value.policyRef.kind) || !STABLE_ID.test(value.policyRef.id) || !SHA256.test(value.policyRef.digest) ||
    epoch(value.expiresAt, "PROFILE_APPROVAL_POLICY_REFUSED") <= nowEpoch
  ) {
    throw new ControlError("PROFILE_APPROVAL_POLICY_REFUSED", 403);
  }
  const reviewers = [...value.eligibleReviewerDigests].sort();
  if (new Set(reviewers).size !== reviewers.length || reviewers.includes(requesterDigest) || reviewers.some((item) => !SHA256.test(item))) {
    throw new ControlError("PROFILE_APPROVAL_POLICY_REFUSED", 403);
  }
  return Object.freeze({ ...value, policyRef: Object.freeze({ ...value.policyRef }), eligibleReviewerDigests: Object.freeze(reviewers) });
}

function approvalResource(row: ApprovalRow): ProfileApprovalResource {
  return Object.freeze({
    apiVersion: HARNESS_API_VERSION,
    kind: "ApprovalRequest",
    metadata: Object.freeze({ id: row.id, version: `0.1.${row.revision - 1}` }),
    spec: Object.freeze({
      organizationId: tenantId(row.organizationId),
      approvalType: "PROFILE",
      state: row.state,
      subject: Object.freeze({ kind: "harness-profile", id: row.profileId, digest: row.reviewDigest }),
      policyRef: Object.freeze({ ...row.policy.policyRef }),
      requiredDecisions: row.policy.requiredDecisions,
      requestedBy: Object.freeze({ type: "HUMAN", id: actorId(row.requesterDigest) }),
      requestedAt: row.requestedAt,
      expiresAt: row.policy.expiresAt,
      decisions: Object.freeze(row.decisions.map(({ actorDigest: _hidden, ...decision }) => Object.freeze({ ...decision }))),
      reasonCode: row.reasonCode,
    }),
  });
}

function approvalDigest(row: ApprovalRow): string {
  return sha256(canonicalJson(approvalResource(row)));
}

function approvalProjection(row: ApprovalRow): ProfileApprovalProjection {
  return Object.freeze({
    schemaVersion: PROFILE_REVIEW_SCHEMA,
    id: row.id,
    profileId: row.profileId,
    profileRevision: row.profileRevision,
    resultKey: row.resultKey,
    reviewDigest: row.reviewDigest,
    state: row.state,
    revision: row.revision,
    digest: approvalDigest(row),
    policyDigest: row.policyDigest,
    eligibleReviewerCount: row.policy.eligibleReviewerDigests.length,
    approvedDecisionCount: row.decisions.filter((decision) => decision.decision === "APPROVE").length,
    resource: approvalResource(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function approvalResponse(row: ApprovalRow, status: number): StoredResponse<ProfileApprovalProjection> {
  const body = approvalProjection(row);
  return Object.freeze({ status, body, etag: `"${sha256(canonicalJson({ id: row.id, revision: row.revision, digest: body.digest })).slice(7)}"` });
}

function bundleProjection(row: BundleRow): BundleRequestProjection {
  return Object.freeze({
    schemaVersion: PROFILE_REVIEW_SCHEMA,
    id: row.id,
    state: row.state,
    profileId: row.profileId,
    profileLockDigest: row.profileLockDigest,
    operation: row.operation,
    sourceFreshness: row.sourceId === null ? "SOURCE_UNAVAILABLE" : "CURRENT",
    sourceId: row.sourceId,
    sourceSequence: row.sourceSequence,
    sourceObservedAt: row.sourceObservedAt,
    releaseRef: row.releaseRef,
    release: row.release,
    requestedAt: row.requestedAt,
    updatedAt: row.updatedAt,
    evidenceBoundary: "SOURCE_REPORTED_ONLY",
  });
}

function bundleResponse(row: BundleRow, status: number): StoredResponse<BundleRequestProjection> {
  const body = bundleProjection(row);
  return Object.freeze({ status, body, etag: `"${sha256(canonicalJson(body)).slice(7)}"` });
}

function fingerprintRequired(value: string): void {
  if (!SHA256.test(value)) throw new ControlError("REQUEST_FINGERPRINT_REFUSED", 400);
}

function idempotencyRequired(value: string): void {
  if (!IDEMPOTENCY_KEY.test(value)) throw new ControlError("IDEMPOTENCY_KEY_REFUSED", 400);
}

export function profileMutationFingerprint(method: string, path: string, body: unknown): string {
  return sha256(canonicalJson({ method, path, body }));
}

export class ProfileLifecycleStore {
  private readonly profiles = new Map<string, ProfileRow>();
  private readonly approvals = new Map<string, ApprovalRow>();
  private readonly locks = new Map<string, LockRow>();
  private readonly bundles = new Map<string, BundleRow>();
  private readonly bundleByLock = new Map<string, string>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly inbox = new Map<string, { readonly fingerprint: string; readonly envelope: DistributionStatusEnvelope }>();
  private readonly sourceSequences = new Map<string, number>();
  private readonly audit: ProfileAuditEvent[] = [];
  private readonly outbox: DigestOutboxRecord[] = [];
  private failAudit = false;

  constructor(
    private readonly policy: ProfileApprovalPolicyHook,
    private readonly operations: OperationStore,
    private readonly allowedDistributionSources: ReadonlySet<string> = new Set(),
    private readonly auditChain = new TenantAuditChain(),
  ) {}

  registerCompiledProfile(registration: CompiledProfileRegistration): ProfileProjection {
    if (
      !UUID.test(registration.organizationId) || !STABLE_ID.test(registration.profileId) ||
      !Number.isSafeInteger(registration.profileRevision) || registration.profileRevision < 1 ||
      !SHA256.test(registration.resultKey) || !UUID.test(registration.demandId) ||
      !Number.isSafeInteger(registration.demandRevision) || registration.demandRevision < 1 ||
      !SHA256.test(registration.demandDigest) || !SHA256.test(registration.compilerWheelDigest) ||
      !SHA256.test(registration.catalogDigest) || !RFC3339.test(registration.createdAt) ||
      Object.keys(registration.outputDigests).length !== OUTPUT_NAMES.length ||
      Object.keys(registration.outputDigests).some((name) => !OUTPUT_SET.has(name)) ||
      OUTPUT_NAMES.some((name) => !SHA256.test(registration.outputDigests[name]))
    ) {
      throw new ControlError("PROFILE_REGISTRATION_REFUSED", 422);
    }
    const key = `${registration.organizationId}:${registration.profileId}`;
    if (this.profiles.has(key)) throw new ControlError("PROFILE_REVISION_EXISTS", 409);
    const outputs = cloneOutputs(registration.outputs);
    const expectedOutputDigests = Object.freeze({ ...registration.outputDigests });
    const expectedResultKey = sha256(canonicalJson({
      binding: [
        registration.organizationId,
        registration.demandId,
        registration.demandRevision,
        registration.demandDigest,
        registration.compilerWheelDigest,
        registration.catalogDigest,
      ],
      profileDigest: expectedOutputDigests["profile.json"],
    }));
    if (registration.resultKey !== expectedResultKey) throw new ControlError("PROFILE_RESULT_KEY_REFUSED", 422);
    const row: ProfileRow = Object.freeze({
      ...registration,
      outputs,
      expectedOutputDigests,
      state: "PROPOSED",
      revision: 1,
      approvalId: null,
      lockId: null,
      bundleRequestId: null,
      updatedAt: registration.createdAt,
    });
    verifyProfile(row);
    this.profiles.set(key, row);
    return this.profileProjection(row);
  }

  failNextAuditForTest(): void {
    this.failAudit = true;
  }

  tamperOutputForTest(organizationId: string, profileId: string, name: OutputName, bytes: Uint8Array): void {
    const key = `${organizationId}:${profileId}`;
    const row = this.profiles.get(key);
    if (!row) throw new ControlError("PROFILE_NOT_FOUND", 404);
    this.profiles.set(key, Object.freeze({ ...row, outputs: Object.freeze({ ...row.outputs, [name]: new Uint8Array(bytes) }) }));
  }

  readProfile(context: TenantContext, profileId: string): StoredResponse<ProfileProjection> {
    assertContext(context);
    const row = this.profile(context.organizationId, profileId);
    const body = this.profileProjection(row);
    return Object.freeze({ status: 200, body, etag: `"${sha256(canonicalJson(body)).slice(7)}"` });
  }

  explanation(context: TenantContext, profileId: string): Uint8Array {
    assertContext(context);
    const row = this.profile(context.organizationId, profileId);
    verifyProfile(row);
    decoded(row.outputs["explanation.md"], "PROFILE_REVISION_TAMPERED");
    return new Uint8Array(row.outputs["explanation.md"]);
  }

  requestApproval(
    context: TenantContext,
    profileId: string,
    ifMatch: string | null,
    idempotencyKey: string,
    fingerprint: string,
    nowEpoch: number,
  ): StoredResponse<ProfileApprovalProjection> {
    assertContext(context);
    const replay = this.replay<ProfileApprovalProjection>(context, idempotencyKey, fingerprint);
    if (replay) return replay;
    if (ifMatch === null) throw new ControlError("PRECONDITION_REQUIRED", 428);
    const current = this.readProfile(context, profileId);
    if (current.etag !== ifMatch) throw new ControlError("PRECONDITION_FAILED", 412);
    const row = this.profile(context.organizationId, profileId);
    const verified = verifyProfile(row);
    if (row.state !== "PROPOSED") throw new ControlError("PROFILE_APPROVAL_STATE_REFUSED", 409);
    const profileSpec = object(verified.profile.spec, "PROFILE_REVISION_TAMPERED");
    if ((profileSpec.proposedSelectors as readonly unknown[]).length > 0) throw new ControlError("PROFILE_SELECTORS_UNRESOLVED", 409);
    const now = timestamp(nowEpoch);
    const result = this.policy.evaluate(Object.freeze({
      organizationId: context.organizationId,
      profileId,
      profileRevision: row.profileRevision,
      resultKey: row.resultKey,
      reviewDigest: verified.reviewDigest,
      requesterDigest: context.subjectDigest,
      requestedAt: now,
    }));
    if (result.disposition === "UNAVAILABLE") throw new ControlError("PROFILE_APPROVAL_POLICY_UNAVAILABLE", 503);
    if (result.disposition === "DENIED") throw new ControlError("PROFILE_APPROVAL_POLICY_DENIED", 403);
    const admitted = validatePolicy(result, context.subjectDigest, nowEpoch);
    const approval: ApprovalRow = Object.freeze({
      id: `approval.${randomUUID().replaceAll("-", "")}`,
      organizationId: context.organizationId,
      profileId,
      profileRevision: row.profileRevision,
      resultKey: row.resultKey,
      reviewDigest: verified.reviewDigest,
      requesterDigest: context.subjectDigest,
      policy: admitted,
      policyDigest: policyDigest(admitted),
      state: "PENDING",
      revision: 1,
      decisions: Object.freeze([]),
      reasonCode: null,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const changed: ProfileRow = Object.freeze({ ...row, state: "APPROVAL_PENDING", revision: row.revision + 1, approvalId: approval.id, updatedAt: now });
    const response = approvalResponse(approval, 202);
    const audit = this.auditRecord(context.organizationId, "profile.approval.requested.v1", approval.id, response.body.digest, context.subjectDigest, now);
    const outbox = this.outboxRecord(context.organizationId, "approval.requested.v1", approval.id, response.body.digest, now);
    this.commitAudit([audit]);
    this.approvals.set(`${context.organizationId}:${approval.id}`, approval);
    this.profiles.set(`${context.organizationId}:${profileId}`, changed);
    this.outbox.push(outbox);
    this.remember(context, idempotencyKey, fingerprint, response);
    return response;
  }

  readApproval(context: TenantContext, profileId: string): StoredResponse<ProfileApprovalProjection> {
    assertContext(context);
    const row = this.profile(context.organizationId, profileId);
    verifyProfile(row);
    if (!row.approvalId) throw new ControlError("PROFILE_APPROVAL_NOT_FOUND", 404);
    return approvalResponse(this.approval(context.organizationId, row.approvalId), 200);
  }

  decide(
    context: TenantContext,
    profileId: string,
    decision: { readonly decision: "APPROVE" | "REJECT"; readonly reasonCode: string },
    ifMatch: string | null,
    idempotencyKey: string,
    fingerprint: string,
    nowEpoch: number,
  ): StoredResponse<ProfileApprovalProjection> {
    assertContext(context);
    if (!REASON_CODE.test(decision.reasonCode) || decision.reasonCode.length > 64) throw new ControlError("PROFILE_DECISION_REFUSED", 422);
    const replay = this.replay<ProfileApprovalProjection>(context, idempotencyKey, fingerprint);
    if (replay) return replay;
    if (ifMatch === null) throw new ControlError("PRECONDITION_REQUIRED", 428);
    const profile = this.profile(context.organizationId, profileId);
    const verified = verifyProfile(profile);
    if (!profile.approvalId) throw new ControlError("PROFILE_APPROVAL_NOT_FOUND", 404);
    const approval = this.approval(context.organizationId, profile.approvalId);
    const current = approvalResponse(approval, 200);
    if (current.etag !== ifMatch) throw new ControlError("PRECONDITION_FAILED", 412);
    if (approval.state !== "PENDING" || profile.state !== "APPROVAL_PENDING") throw new ControlError("PROFILE_APPROVAL_STATE_REFUSED", 409);
    if (approval.reviewDigest !== verified.reviewDigest || approval.resultKey !== profile.resultKey || approval.profileRevision !== profile.profileRevision) {
      throw new ControlError("PROFILE_APPROVAL_BINDING_REFUSED", 409);
    }
    if (epoch(approval.policy.expiresAt, "PROFILE_APPROVAL_POLICY_REFUSED") <= nowEpoch) {
      const expiredAt = timestamp(nowEpoch);
      const expired = Object.freeze({
        ...approval, state: "EXPIRED", revision: approval.revision + 1, reasonCode: "APPROVAL_EXPIRED", updatedAt: expiredAt,
      } satisfies ApprovalRow);
      const audit = this.auditRecord(context.organizationId, "profile.approval.expired.v1", approval.id, approvalDigest(expired), context.subjectDigest, expiredAt);
      this.commitAudit([audit]);
      this.approvals.set(`${context.organizationId}:${approval.id}`, expired);
      throw new ControlError("PROFILE_APPROVAL_EXPIRED", 409);
    }
    if (
      context.subjectDigest === approval.requesterDigest ||
      !approval.policy.eligibleReviewerDigests.includes(context.subjectDigest) ||
      approval.decisions.some((item) => item.actorDigest === context.subjectDigest)
    ) {
      throw new ControlError("PROFILE_REVIEWER_REFUSED", 403);
    }
    const now = timestamp(nowEpoch);
    const decisions = Object.freeze([...approval.decisions, Object.freeze({
      actor: Object.freeze({ type: "HUMAN" as const, id: actorId(context.subjectDigest) }),
      actorDigest: context.subjectDigest,
      decision: decision.decision,
      decidedAt: now,
      reasonCode: decision.reasonCode,
    })]);
    const approvedCount = decisions.filter((item) => item.decision === "APPROVE").length;
    const nextState: ApprovalState = decision.decision === "REJECT" ? "REJECTED" : approvedCount >= approval.policy.requiredDecisions ? "APPROVED" : "PENDING";
    const changedApproval: ApprovalRow = Object.freeze({
      ...approval,
      state: nextState,
      revision: approval.revision + 1,
      decisions,
      reasonCode: nextState === "PENDING" ? null : decision.reasonCode,
      updatedAt: now,
    });
    const changedProfile: ProfileRow = nextState === "REJECTED"
      ? Object.freeze({ ...profile, state: "REJECTED", revision: profile.revision + 1, updatedAt: now })
      : profile;
    const response = approvalResponse(changedApproval, 200);
    const audit = this.auditRecord(context.organizationId, "profile.approval.decision.v1", approval.id, response.body.digest, context.subjectDigest, now);
    this.commitAudit([audit]);
    this.approvals.set(`${context.organizationId}:${approval.id}`, changedApproval);
    if (changedProfile !== profile) this.profiles.set(`${context.organizationId}:${profileId}`, changedProfile);
    this.remember(context, idempotencyKey, fingerprint, response);
    return response;
  }

  lock(
    context: TenantContext,
    profileId: string,
    ifMatch: string | null,
    idempotencyKey: string,
    fingerprint: string,
    nowEpoch: number,
  ): StoredResponse<ProfileLockProjection> {
    assertContext(context);
    const replay = this.replay<ProfileLockProjection>(context, idempotencyKey, fingerprint);
    if (replay) return replay;
    if (ifMatch === null) throw new ControlError("PRECONDITION_REQUIRED", 428);
    const current = this.readProfile(context, profileId);
    if (current.etag !== ifMatch) throw new ControlError("PRECONDITION_FAILED", 412);
    const profile = this.profile(context.organizationId, profileId);
    const verified = verifyProfile(profile);
    if (profile.state !== "APPROVAL_PENDING" || !profile.approvalId || profile.lockId) throw new ControlError("PROFILE_LOCK_STATE_REFUSED", 409);
    const approval = this.approval(context.organizationId, profile.approvalId);
    if (
      approval.state !== "APPROVED" || epoch(approval.policy.expiresAt, "PROFILE_APPROVAL_POLICY_REFUSED") <= nowEpoch ||
      approval.reviewDigest !== verified.reviewDigest || approval.profileRevision !== profile.profileRevision || approval.resultKey !== profile.resultKey
    ) {
      throw new ControlError("PROFILE_LOCK_APPROVAL_REFUSED", 409);
    }
    const now = timestamp(nowEpoch);
    const lockDigest = sha256(canonicalJson({
      organizationId: context.organizationId,
      profileId,
      profileRevision: profile.profileRevision,
      resultKey: profile.resultKey,
      demand: { id: profile.demandId, revision: profile.demandRevision, digest: profile.demandDigest },
      compilerWheelDigest: profile.compilerWheelDigest,
      catalogDigest: profile.catalogDigest,
      outputDigests: verified.outputDigests,
      approval: { id: approval.id, revision: approval.revision, digest: approvalDigest(approval), policyDigest: approval.policyDigest },
    }));
    const lock: LockRow = Object.freeze({
      schemaVersion: PROFILE_REVIEW_SCHEMA,
      organizationId: context.organizationId,
      id: `lock.${randomUUID().replaceAll("-", "")}`,
      profileId,
      profileRevision: profile.profileRevision,
      resultKey: profile.resultKey,
      profileReviewDigest: verified.reviewDigest,
      approvalId: approval.id,
      approvalRevision: approval.revision,
      approvalDigest: approvalDigest(approval),
      policyDigest: approval.policyDigest,
      digest: lockDigest,
      lockedAt: now,
    });
    const changed: ProfileRow = Object.freeze({ ...profile, state: "LOCKED", revision: profile.revision + 1, lockId: lock.id, updatedAt: now });
    const body = this.publicLock(lock);
    const response: StoredResponse<ProfileLockProjection> = Object.freeze({ status: 201, body, etag: `"${lock.digest.slice(7)}"` });
    const audit = this.auditRecord(context.organizationId, "profile.locked.v1", lock.id, lock.digest, context.subjectDigest, now);
    const outbox = this.outboxRecord(context.organizationId, "profile.locked.v1", lock.id, lock.digest, now);
    this.commitAudit([audit]);
    this.locks.set(`${context.organizationId}:${lock.id}`, lock);
    this.profiles.set(`${context.organizationId}:${profileId}`, changed);
    this.outbox.push(outbox);
    this.remember(context, idempotencyKey, fingerprint, response);
    return response;
  }

  requestBundle(
    context: TenantContext,
    profileId: string,
    ifMatch: string | null,
    idempotencyKey: string,
    fingerprint: string,
    nowEpoch: number,
  ): StoredResponse<BundleRequestProjection> {
    assertContext(context);
    const replay = this.replay<BundleRequestProjection>(context, idempotencyKey, fingerprint);
    if (replay) return replay;
    if (ifMatch === null) throw new ControlError("PRECONDITION_REQUIRED", 428);
    const current = this.readProfile(context, profileId);
    if (current.etag !== ifMatch) throw new ControlError("PRECONDITION_FAILED", 412);
    const profile = this.profile(context.organizationId, profileId);
    const verified = verifyProfile(profile);
    if (profile.state !== "LOCKED" || !profile.lockId) throw new ControlError("BUNDLE_PROFILE_NOT_LOCKED", 409);
    const lock = this.lockRow(context.organizationId, profile.lockId);
    if (lock.profileReviewDigest !== verified.reviewDigest || lock.resultKey !== profile.resultKey) throw new ControlError("PROFILE_LOCK_BINDING_REFUSED", 409);
    const lockKey = `${context.organizationId}:${lock.digest}`;
    if (this.bundleByLock.has(lockKey)) throw new ControlError("BUNDLE_REQUEST_EXISTS", 409);
    this.requireAudit();
    const now = timestamp(nowEpoch);
    const correlationId = randomUUID();
    const operation = this.operations.createBundleOperation(
      context,
      Object.freeze({ kind: "profile-lock", id: lock.id, digest: lock.digest }),
      sha256(idempotencyKey),
      correlationId,
      nowEpoch,
    );
    const bundle: BundleRow = Object.freeze({
      organizationId: context.organizationId,
      id: `bundle-request.${randomUUID().replaceAll("-", "")}`,
      state: "REQUESTED",
      profileId,
      profileReviewDigest: verified.reviewDigest,
      profileLockDigest: lock.digest,
      operation,
      sourceId: null,
      sourceSequence: null,
      sourceObservedAt: null,
      release: null,
      releaseRef: null,
      requestedAt: now,
      updatedAt: now,
    });
    const changed: ProfileRow = Object.freeze({ ...profile, revision: profile.revision + 1, bundleRequestId: bundle.id, updatedAt: now });
    const response = bundleResponse(bundle, 202);
    const requestDigest = sha256(canonicalJson({ id: bundle.id, profileLockDigest: lock.digest, operationId: operation.metadata.id }));
    const audit = this.auditRecord(context.organizationId, "bundle.requested.v1", bundle.id, requestDigest, context.subjectDigest, now);
    const outbox = this.outboxRecord(context.organizationId, "bundle.requested.v1", bundle.id, requestDigest, now);
    this.auditChain.append([audit]);
    this.bundles.set(`${context.organizationId}:${bundle.id}`, bundle);
    this.bundleByLock.set(lockKey, bundle.id);
    this.profiles.set(`${context.organizationId}:${profileId}`, changed);
    this.audit.push(audit);
    this.outbox.push(outbox);
    this.remember(context, idempotencyKey, fingerprint, response);
    return response;
  }

  readBundle(context: TenantContext, bundleId: string): StoredResponse<BundleRequestProjection> {
    assertContext(context, "BUNDLE_REQUEST_NOT_FOUND");
    const row = this.bundles.get(`${context.organizationId}:${bundleId}`);
    if (!row) throw new ControlError("BUNDLE_REQUEST_NOT_FOUND", 404);
    verifyProfile(this.profile(context.organizationId, row.profileId));
    return bundleResponse(row, 200);
  }

  reportSignedBundle(
    authenticatedSourceId: string,
    envelope: DistributionStatusEnvelope,
    nowEpoch: number,
  ): StoredResponse<BundleRequestProjection> {
    const envelopeObject = object(envelope, "BUNDLE_SOURCE_ENVELOPE_REFUSED");
    exact(envelopeObject, ["sourceId", "organizationId", "partitionKey", "eventId", "bundleRequestId", "sequence", "observedAt", "release"], "BUNDLE_SOURCE_ENVELOPE_REFUSED");
    if (
      authenticatedSourceId !== envelope.sourceId || !this.allowedDistributionSources.has(authenticatedSourceId) ||
      !STABLE_ID.test(envelope.sourceId) || !STABLE_ID.test(envelope.organizationId) ||
      envelope.partitionKey !== envelope.organizationId || !UUID.test(envelope.eventId) ||
      !STABLE_ID.test(envelope.bundleRequestId) || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1
    ) {
      throw new ControlError("BUNDLE_SOURCE_ENVELOPE_REFUSED", 403);
    }
    const observedEpoch = epoch(envelope.observedAt, "BUNDLE_SOURCE_ENVELOPE_REFUSED");
    if (observedEpoch > nowEpoch + 300 || observedEpoch < nowEpoch - 3600) throw new ControlError("BUNDLE_SOURCE_STATUS_STALE", 409);
    const fingerprint = sha256(canonicalJson(envelope));
    const delivered = this.inbox.get(envelope.eventId);
    if (delivered) {
      if (delivered.fingerprint !== fingerprint) throw new ControlError("BUNDLE_SOURCE_EVENT_CONFLICT", 409);
      const repeated = [...this.bundles.values()].find((item) => item.id === envelope.bundleRequestId && tenantId(item.organizationId) === envelope.organizationId);
      if (!repeated) throw new ControlError("BUNDLE_REQUEST_NOT_FOUND", 404);
      return bundleResponse(repeated, 200);
    }
    const bundle = [...this.bundles.values()].find((item) => item.id === envelope.bundleRequestId && tenantId(item.organizationId) === envelope.organizationId);
    if (!bundle) throw new ControlError("BUNDLE_REQUEST_NOT_FOUND", 404);
    if (bundle.state !== "REQUESTED") throw new ControlError("BUNDLE_SOURCE_STATE_REFUSED", 409);
    const profile = this.profile(bundle.organizationId, bundle.profileId);
    const verified = verifyProfile(profile);
    if (profile.state !== "LOCKED" || bundle.profileReviewDigest !== verified.reviewDigest) throw new ControlError("BUNDLE_SOURCE_PROFILE_REFUSED", 409);
    const sequenceKey = `${envelope.sourceId}:${envelope.partitionKey}`;
    if (envelope.sequence !== (this.sourceSequences.get(sequenceKey) ?? 0) + 1) throw new ControlError("BUNDLE_SOURCE_SEQUENCE_REFUSED", 409);
    const release = this.validRelease(envelope.release, envelope.organizationId, verified.reviewDigest);
    const releaseDigest = sha256(canonicalJson(release));
    const releaseRef: ResourceRef = Object.freeze({ kind: "bundle-release", id: release.metadata.id, digest: releaseDigest });
    this.requireAudit();
    const operation = this.operations.completeBundleOperation(bundle.organizationId, bundle.operation.metadata.id, releaseRef, nowEpoch);
    const changed: BundleRow = Object.freeze({
      ...bundle,
      state: "SOURCE_REPORTED_SIGNED",
      operation,
      sourceId: envelope.sourceId,
      sourceSequence: envelope.sequence,
      sourceObservedAt: envelope.observedAt,
      release,
      releaseRef,
      updatedAt: timestamp(nowEpoch),
    });
    const audit = this.auditRecord(bundle.organizationId, "bundle.source-reported-signed.v1", bundle.id, releaseDigest, sha256(envelope.sourceId), changed.updatedAt);
    this.auditChain.append([audit]);
    this.bundles.set(`${bundle.organizationId}:${bundle.id}`, changed);
    this.inbox.set(envelope.eventId, Object.freeze({ fingerprint, envelope: immutableJson(envelope) }));
    this.sourceSequences.set(sequenceKey, envelope.sequence);
    this.audit.push(audit);
    return bundleResponse(changed, 200);
  }

  auditEvents(organizationId: string): readonly ProfileAuditEvent[] {
    return Object.freeze(this.audit.filter((item) => item.organizationId === organizationId));
  }

  auditChainRecords(organizationId: string): readonly AuditChainRecord[] {
    return this.auditChain.records(organizationId);
  }

  outboxRecords(organizationId: string): readonly DigestOutboxRecord[] {
    return Object.freeze(this.outbox.filter((item) => item.organizationId === organizationId));
  }

  inboxCount(): number {
    return this.inbox.size;
  }

  bundleCount(): number {
    return this.bundles.size;
  }

  private profile(organizationId: string, profileId: string): ProfileRow {
    if (!STABLE_ID.test(profileId)) throw new ControlError("PROFILE_NOT_FOUND", 404);
    const row = this.profiles.get(`${organizationId}:${profileId}`);
    if (!row) throw new ControlError("PROFILE_NOT_FOUND", 404);
    return row;
  }

  private approval(organizationId: string, approvalId: string): ApprovalRow {
    const row = this.approvals.get(`${organizationId}:${approvalId}`);
    if (!row) throw new ControlError("PROFILE_APPROVAL_NOT_FOUND", 404);
    return row;
  }

  private lockRow(organizationId: string, lockId: string): LockRow {
    const row = this.locks.get(`${organizationId}:${lockId}`);
    if (!row) throw new ControlError("PROFILE_LOCK_NOT_FOUND", 404);
    return row;
  }

  private profileProjection(row: ProfileRow): ProfileProjection {
    const verified = verifyProfile(row);
    const approval = row.approvalId ? this.approval(row.organizationId, row.approvalId) : null;
    const lock = row.lockId ? this.lockRow(row.organizationId, row.lockId) : null;
    const bundle = row.bundleRequestId ? this.bundles.get(`${row.organizationId}:${row.bundleRequestId}`) ?? null : null;
    return Object.freeze({
      schemaVersion: PROFILE_REVIEW_SCHEMA,
      id: row.profileId,
      state: row.state,
      revision: row.revision,
      resultKey: row.resultKey,
      reviewDigest: verified.reviewDigest,
      demand: Object.freeze({ id: row.demandId, revision: row.demandRevision, digest: row.demandDigest }),
      compilerWheelDigest: row.compilerWheelDigest,
      catalogDigest: row.catalogDigest,
      outputDigests: verified.outputDigests,
      profile: verified.profile,
      summaries: Object.freeze({
        billOfMaterials: Object.freeze({ digest: verified.outputDigests["bom.json"], byteLength: row.outputs["bom.json"].byteLength }),
        installPlan: Object.freeze({ digest: verified.outputDigests["install-plan.json"], byteLength: row.outputs["install-plan.json"].byteLength }),
        evidencePlan: Object.freeze({ digest: verified.outputDigests["evidence-plan.json"], byteLength: row.outputs["evidence-plan.json"].byteLength }),
      }),
      approval: approval ? Object.freeze({ id: approval.id, state: approval.state, digest: approvalDigest(approval) }) : null,
      lock: lock ? Object.freeze({ id: lock.id, digest: lock.digest, lockedAt: lock.lockedAt }) : null,
      bundle: bundle ? Object.freeze({ id: bundle.id, state: bundle.state, sourceFreshness: bundle.sourceId ? "CURRENT" as const : "SOURCE_UNAVAILABLE" as const }) : null,
      evidenceAxes: Object.freeze({
        source: "PASS",
        contractUnit: "PASS",
        artifactSbom: "MISSING",
        signatureRelease: bundle?.state === "SOURCE_REPORTED_SIGNED" ? "SOURCE_REPORTED_ONLY" : "MISSING",
        deployment: "NOT_RUN_ENV_UNAVAILABLE",
        runtime: "NOT_RUN_ENV_UNAVAILABLE",
        security: "NOT_RUN_ENV_UNAVAILABLE",
        assurance: "MISSING",
        tenantAcceptance: "MISSING",
      }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private publicLock(row: LockRow): ProfileLockProjection {
    const { organizationId: _hidden, ...projection } = row;
    return Object.freeze(projection);
  }

  private replay<T>(context: TenantContext, idempotencyKey: string, fingerprint: string): StoredResponse<T> | null {
    idempotencyRequired(idempotencyKey);
    fingerprintRequired(fingerprint);
    const existing = this.idempotency.get(`${context.organizationId}:${sha256(idempotencyKey)}`);
    if (!existing) return null;
    if (existing.fingerprint !== fingerprint) throw new ControlError("IDEMPOTENCY_CONFLICT", 409);
    return existing.response as StoredResponse<T>;
  }

  private remember<T>(context: TenantContext, idempotencyKey: string, fingerprint: string, response: StoredResponse<T>): void {
    this.idempotency.set(`${context.organizationId}:${sha256(idempotencyKey)}`, Object.freeze({ fingerprint, response }));
  }

  private requireAudit(): void {
    if (this.failAudit) {
      this.failAudit = false;
      throw new ControlError("AUDIT_WRITE_REFUSED", 500);
    }
  }

  private commitAudit(events: readonly ProfileAuditEvent[]): void {
    this.requireAudit();
    this.auditChain.append(events);
    this.audit.push(...events.map((event) => Object.freeze(event)));
  }

  private auditRecord(
    organizationId: string,
    eventType: string,
    aggregateId: string,
    aggregateDigest: string,
    actorDigest: string,
    occurredAt: string,
  ): ProfileAuditEvent {
    return Object.freeze({ eventId: randomUUID(), organizationId, eventType, aggregateId, aggregateDigest, actorDigest, occurredAt });
  }

  private outboxRecord(
    organizationId: string,
    eventType: DigestOutboxRecord["eventType"],
    aggregateId: string,
    aggregateDigest: string,
    occurredAt: string,
  ): DigestOutboxRecord {
    return Object.freeze({ eventId: randomUUID(), organizationId, eventType, aggregateId, aggregateDigest, occurredAt });
  }

  private validRelease(value: BundleReleaseResource, organizationId: string, profileDigest: string): BundleReleaseResource {
    const release = object(value, "BUNDLE_RELEASE_REFUSED");
    exact(release, ["apiVersion", "kind", "metadata", "spec"], "BUNDLE_RELEASE_REFUSED");
    const metadata = object(release.metadata, "BUNDLE_RELEASE_REFUSED");
    const spec = object(release.spec, "BUNDLE_RELEASE_REFUSED");
    exact(metadata, ["id", "version"], "BUNDLE_RELEASE_REFUSED");
    exact(spec, ["organizationId", "state", "profileDigest", "bundleDigest", "releaseDigest", "manifestDigest", "signatureDigest", "supersedesReleaseDigest", "reasonCode"], "BUNDLE_RELEASE_REFUSED");
    if (
      release.apiVersion !== HARNESS_API_VERSION || release.kind !== "BundleRelease" ||
      !STABLE_ID.test(String(metadata.id)) || !/^\d+\.\d+\.\d+$/u.test(String(metadata.version)) ||
      spec.organizationId !== organizationId || spec.state !== "SIGNED" || spec.profileDigest !== profileDigest ||
      !SHA256.test(String(spec.bundleDigest)) || !SHA256.test(String(spec.releaseDigest)) ||
      !SHA256.test(String(spec.manifestDigest)) || !SHA256.test(String(spec.signatureDigest)) ||
      (spec.supersedesReleaseDigest !== null && !SHA256.test(String(spec.supersedesReleaseDigest))) || spec.reasonCode !== null
    ) {
      throw new ControlError("BUNDLE_RELEASE_REFUSED", 422);
    }
    return immutableJson(value);
  }
}
