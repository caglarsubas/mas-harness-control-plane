import { randomUUID } from "node:crypto";

import { canonicalJson, sha256 } from "../foundation/canonical";
import { ControlError, type TenantContext } from "../foundation/contracts";
import type {
  AdmittedApprovalPolicy,
  ApprovalDecisionRecord,
  ApprovalPolicyHook,
  ApprovalProjection,
  ApprovalRequestResource,
  ApprovalState,
  AssuranceSubjects,
  DemandAuditEvent,
  DemandCreateInput,
  DemandFinding,
  DemandProjection,
  DemandSourceReference,
  DemandSourceResolver,
  DemandState,
  EnvironmentInput,
  ExecutionBudget,
  PolicyAdmissionRequest,
  PrerequisiteDecisionInput,
  ResourceRef,
  StoredResponse,
  TenantDemandResource,
} from "./contracts";
import { DEMAND_SCHEMA, HARNESS_API_VERSION } from "./contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u;
const REASON_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const RFC3339 = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const TERMINAL_DEMAND = new Set<DemandState>(["APPROVED", "REJECTED", "SUPERSEDED"]);
const TERMINAL_APPROVAL = new Set<ApprovalState>(["APPROVED", "REJECTED", "EXPIRED", "CANCELLED"]);

const DEMAND_TRANSITIONS: Readonly<Record<DemandState, readonly DemandState[]>> = Object.freeze({
  DRAFT: Object.freeze(["BLOCKED", "VALIDATED"]),
  BLOCKED: Object.freeze(["VALIDATED", "SUPERSEDED"]),
  VALIDATED: Object.freeze(["APPROVAL_PENDING", "SUPERSEDED"]),
  APPROVAL_PENDING: Object.freeze(["APPROVED", "REJECTED", "BLOCKED", "SUPERSEDED"]),
  APPROVED: Object.freeze([]),
  REJECTED: Object.freeze([]),
  SUPERSEDED: Object.freeze([]),
});

interface DemandRow {
  readonly id: string;
  readonly organizationId: string;
  readonly creatorDigest: string;
  readonly input: DemandCreateInput;
  readonly tenantDemand: TenantDemandResource;
  readonly state: DemandState;
  readonly revision: number;
  readonly validatedResourceDigest: string | null;
  readonly validatedRevision: number | null;
  readonly approvalId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ApprovalRow {
  readonly id: string;
  readonly organizationId: string;
  readonly demandId: string;
  readonly demandRevision: number;
  readonly demandDigest: string;
  readonly requesterDigest: string;
  readonly policyRequest: PolicyAdmissionRequest;
  readonly policy: AdmittedApprovalPolicy;
  readonly policyBindingDigest: string;
  readonly state: ApprovalState;
  readonly revision: number;
  readonly decisions: readonly ApprovalDecisionRecord[];
  readonly reasonCode: string | null;
  readonly requestedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly response: StoredResponse<unknown>;
}

interface PrerequisiteDecisionRecord extends PrerequisiteDecisionInput {
  readonly organizationId: string;
  readonly demandId: string;
  readonly revision: number;
  readonly actorDigest: string;
  readonly occurredAt: string;
}

function object(value: unknown, code = "DEMAND_INPUT_REFUSED"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ControlError(code, 422);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], code = "DEMAND_INPUT_REFUSED"): void {
  const expected = new Set(keys);
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !expected.has(key))) {
    throw new ControlError(code, 422);
  }
}

function stableId(value: unknown, code = "DEMAND_INPUT_REFUSED"): string {
  if (typeof value !== "string" || !STABLE_ID.test(value) || value.length > 160) throw new ControlError(code, 422);
  return value;
}

function digest(value: unknown, code = "DEMAND_INPUT_REFUSED"): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new ControlError(code, 422);
  return value;
}

function reasonCode(value: unknown, code = "DEMAND_INPUT_REFUSED"): string {
  if (typeof value !== "string" || !REASON_CODE.test(value) || value.length > 64) throw new ControlError(code, 422);
  return value;
}

function timestamp(nowEpoch: number): string {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) throw new ControlError("DEMAND_TIME_REFUSED", 500);
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

function assertContext(context: TenantContext, notFoundCode: string): void {
  if (!UUID.test(context.organizationId) || !SHA256.test(context.subjectDigest)) throw new ControlError(notFoundCode, 404);
}

function uniqueStableIds(value: unknown, minimum: number, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new ControlError("DEMAND_INPUT_REFUSED", 422);
  const accepted = value.map((item) => stableId(item));
  if (new Set(accepted).size !== accepted.length) throw new ControlError("DEMAND_INPUT_REFUSED", 422);
  return Object.freeze([...accepted].sort());
}

function sourceReference(value: unknown): DemandSourceReference {
  const source = object(value);
  exact(source, [
    "questionnaireSessionId",
    "questionnaireSessionRevision",
    "questionnaireAnswerSetId",
    "questionnaireAnswerSetDigest",
    "readinessAssessmentId",
    "readinessAssessmentDigest",
  ]);
  if (typeof source.questionnaireSessionId !== "string" || !UUID.test(source.questionnaireSessionId)) {
    throw new ControlError("DEMAND_INPUT_REFUSED", 422);
  }
  if (!Number.isSafeInteger(source.questionnaireSessionRevision) || Number(source.questionnaireSessionRevision) < 1) {
    throw new ControlError("DEMAND_INPUT_REFUSED", 422);
  }
  return Object.freeze({
    questionnaireSessionId: source.questionnaireSessionId,
    questionnaireSessionRevision: Number(source.questionnaireSessionRevision),
    questionnaireAnswerSetId: stableId(source.questionnaireAnswerSetId),
    questionnaireAnswerSetDigest: digest(source.questionnaireAnswerSetDigest),
    readinessAssessmentId: stableId(source.readinessAssessmentId),
    readinessAssessmentDigest: digest(source.readinessAssessmentDigest),
  });
}

function environment(value: unknown): EnvironmentInput {
  const item = object(value);
  exact(item, [
    "deploymentMode",
    "architecture",
    "operatingSystem",
    "kubernetesDistribution",
    "capabilities",
    "attestationDigest",
    "signatureStatus",
  ]);
  const deploymentModes = new Set(["operator-hosted-saas", "tenant-public-cloud", "self-managed", "air-gapped"]);
  const architectures = new Set(["amd64", "arm64", "platform-supplied"]);
  const operatingSystems = new Set(["linux", "macos", "platform-supplied"]);
  const kubernetes = new Set(["upstream", "k3s", "openshift", "none", "platform-supplied"]);
  if (
    typeof item.deploymentMode !== "string" || !deploymentModes.has(item.deploymentMode) ||
    typeof item.architecture !== "string" || !architectures.has(item.architecture) ||
    typeof item.operatingSystem !== "string" || !operatingSystems.has(item.operatingSystem) ||
    typeof item.kubernetesDistribution !== "string" || !kubernetes.has(item.kubernetesDistribution) ||
    item.signatureStatus !== "VERIFIED"
  ) {
    throw new ControlError("DEMAND_INPUT_REFUSED", 422);
  }
  return Object.freeze({
    deploymentMode: item.deploymentMode as EnvironmentInput["deploymentMode"],
    architecture: item.architecture as EnvironmentInput["architecture"],
    operatingSystem: item.operatingSystem as EnvironmentInput["operatingSystem"],
    kubernetesDistribution: item.kubernetesDistribution as EnvironmentInput["kubernetesDistribution"],
    capabilities: uniqueStableIds(item.capabilities, 0, 128),
    attestationDigest: digest(item.attestationDigest),
    signatureStatus: "VERIFIED",
  });
}

function assuranceSubjects(value: unknown): AssuranceSubjects {
  const item = object(value);
  exact(item, ["harnessIds", "capabilityIds"]);
  return Object.freeze({
    harnessIds: uniqueStableIds(item.harnessIds, 0, 64),
    capabilityIds: uniqueStableIds(item.capabilityIds, 0, 128),
  });
}

function executionBudget(value: unknown): ExecutionBudget {
  const item = object(value);
  exact(item, ["maxConcurrentTasks", "maxTaskSeconds", "maxRetries", "maxToolCalls", "maxModelTokens"]);
  const ranges: Readonly<Record<keyof ExecutionBudget, readonly [number, number]>> = Object.freeze({
    maxConcurrentTasks: [1, 1024],
    maxTaskSeconds: [1, 86_400],
    maxRetries: [0, 100],
    maxToolCalls: [0, 10_000],
    maxModelTokens: [0, 10_000_000],
  });
  for (const [name, [minimum, maximum]] of Object.entries(ranges) as [keyof ExecutionBudget, readonly [number, number]][]) {
    if (!Number.isSafeInteger(item[name]) || Number(item[name]) < minimum || Number(item[name]) > maximum) {
      throw new ControlError("DEMAND_EXECUTION_BUDGET_REFUSED", 422);
    }
  }
  return Object.freeze({
    maxConcurrentTasks: Number(item.maxConcurrentTasks),
    maxTaskSeconds: Number(item.maxTaskSeconds),
    maxRetries: Number(item.maxRetries),
    maxToolCalls: Number(item.maxToolCalls),
    maxModelTokens: Number(item.maxModelTokens),
  });
}

function validatedInput(value: DemandCreateInput): DemandCreateInput {
  const item = object(value);
  exact(item, [
    "source",
    "requestedCapabilities",
    "proposedPrerequisiteHarnessIds",
    "prerequisiteDecisions",
    "environment",
    "assuranceSubjects",
    "executionBudget",
  ]);
  const proposed = uniqueStableIds(item.proposedPrerequisiteHarnessIds, 0, 64);
  if (!Array.isArray(item.prerequisiteDecisions) || item.prerequisiteDecisions.length !== proposed.length) {
    throw new ControlError("PREREQUISITE_DECISION_SET_REFUSED", 422);
  }
  const seen = new Set<string>();
  const decisions = item.prerequisiteDecisions.map((candidate): PrerequisiteDecisionInput => {
    const decision = object(candidate, "PREREQUISITE_DECISION_SET_REFUSED");
    exact(decision, ["harnessId", "decision", "reasonCode"], "PREREQUISITE_DECISION_SET_REFUSED");
    const harnessId = stableId(decision.harnessId, "PREREQUISITE_DECISION_SET_REFUSED");
    if (
      seen.has(harnessId) || !proposed.includes(harnessId) ||
      (decision.decision !== "ACCEPT" && decision.decision !== "REJECT")
    ) {
      throw new ControlError("PREREQUISITE_DECISION_SET_REFUSED", 422);
    }
    seen.add(harnessId);
    return Object.freeze({
      harnessId,
      decision: decision.decision,
      reasonCode: reasonCode(decision.reasonCode, "PREREQUISITE_DECISION_SET_REFUSED"),
    });
  }).sort((left, right) => left.harnessId.localeCompare(right.harnessId));
  if (proposed.some((harnessId) => !seen.has(harnessId))) throw new ControlError("PREREQUISITE_DECISION_SET_REFUSED", 422);
  return Object.freeze({
    source: sourceReference(item.source),
    requestedCapabilities: uniqueStableIds(item.requestedCapabilities, 1, 256),
    proposedPrerequisiteHarnessIds: proposed,
    prerequisiteDecisions: Object.freeze(decisions),
    environment: environment(item.environment),
    assuranceSubjects: assuranceSubjects(item.assuranceSubjects),
    executionBudget: executionBudget(item.executionBudget),
  });
}

function tenantDemand(id: string, organizationId: string, input: DemandCreateInput): TenantDemandResource {
  return Object.freeze({
    apiVersion: HARNESS_API_VERSION,
    kind: "TenantDemand",
    metadata: Object.freeze({ id: `demand.${id.replaceAll("-", "")}`, version: "0.1.0" }),
    spec: Object.freeze({
      tenantId: tenantId(organizationId),
      questionnaireAnswerSetId: input.source.questionnaireAnswerSetId,
      readinessAssessmentId: input.source.readinessAssessmentId,
      requestedCapabilities: Object.freeze([...input.requestedCapabilities]),
      acceptedPrerequisiteHarnessIds: Object.freeze(input.prerequisiteDecisions
        .filter((decision) => decision.decision === "ACCEPT")
        .map((decision) => decision.harnessId)
        .sort()),
      environment: Object.freeze({ tenantId: tenantId(organizationId), ...input.environment }),
      assuranceSubjects: Object.freeze({
        harnessIds: Object.freeze([...input.assuranceSubjects.harnessIds]),
        capabilityIds: Object.freeze([...input.assuranceSubjects.capabilityIds]),
      }),
      executionBudget: Object.freeze({ ...input.executionBudget }),
    }),
  });
}

function demandDigest(row: DemandRow): string {
  return sha256(canonicalJson({
    id: row.id,
    state: row.state,
    revision: row.revision,
    tenantDemandDigest: sha256(canonicalJson(row.tenantDemand)),
    validatedResourceDigest: row.validatedResourceDigest,
    approvalId: row.approvalId,
  }));
}

function demandEtag(row: DemandRow): string {
  return `"${demandDigest(row).slice("sha256:".length)}"`;
}

function approvalResource(row: ApprovalRow): ApprovalRequestResource {
  return Object.freeze({
    apiVersion: HARNESS_API_VERSION,
    kind: "ApprovalRequest",
    metadata: Object.freeze({ id: `approval.${row.id.replaceAll("-", "")}`, version: `0.1.${row.revision - 1}` }),
    spec: Object.freeze({
      organizationId: tenantId(row.organizationId),
      approvalType: "DEMAND",
      state: row.state,
      subject: Object.freeze({ kind: "tenant-demand", id: `demand.${row.demandId.replaceAll("-", "")}`, digest: row.demandDigest }),
      policyRef: Object.freeze({ ...row.policy.policyRef }),
      requiredDecisions: row.policy.requiredDecisions,
      requestedBy: Object.freeze({ type: "HUMAN", id: actorId(row.requesterDigest) }),
      requestedAt: row.requestedAt,
      expiresAt: row.policy.expiresAt,
      decisions: Object.freeze(row.decisions.map(({ actorDigest: _hidden, ...decision }) => Object.freeze(decision))),
      reasonCode: row.reasonCode,
    }),
  });
}

function approvalDigest(row: ApprovalRow): string {
  return sha256(canonicalJson(approvalResource(row)));
}

function approvalEtag(row: ApprovalRow): string {
  return `"${sha256(canonicalJson({ id: row.id, revision: row.revision, digest: approvalDigest(row) })).slice("sha256:".length)}"`;
}

function demandProjection(row: DemandRow, findings: readonly DemandFinding[]): DemandProjection {
  return Object.freeze({
    schemaVersion: DEMAND_SCHEMA,
    id: row.id,
    state: row.state,
    revision: row.revision,
    digest: demandDigest(row),
    validatedResourceDigest: row.validatedResourceDigest,
    source: Object.freeze({ ...row.input.source }),
    proposedPrerequisiteHarnessIds: Object.freeze([...row.input.proposedPrerequisiteHarnessIds]),
    prerequisiteDecisions: Object.freeze(row.input.prerequisiteDecisions.map((decision) => Object.freeze({ ...decision }))),
    findings: Object.freeze([...findings]),
    tenantDemand: row.tenantDemand,
    approvalId: row.approvalId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function approvalProjection(row: ApprovalRow): ApprovalProjection {
  return Object.freeze({
    schemaVersion: DEMAND_SCHEMA,
    id: row.id,
    demandId: row.demandId,
    demandRevision: row.demandRevision,
    demandDigest: row.demandDigest,
    state: row.state,
    revision: row.revision,
    digest: approvalDigest(row),
    eligibleReviewerCount: row.policy.eligibleReviewerDigests.length,
    approvedDecisionCount: row.decisions.filter((decision) => decision.decision === "APPROVE").length,
    resource: approvalResource(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function policyRef(value: unknown): ResourceRef {
  const item = object(value, "APPROVAL_POLICY_REFUSED");
  exact(item, ["kind", "id", "digest"], "APPROVAL_POLICY_REFUSED");
  return Object.freeze({
    kind: stableId(item.kind, "APPROVAL_POLICY_REFUSED"),
    id: stableId(item.id, "APPROVAL_POLICY_REFUSED"),
    digest: digest(item.digest, "APPROVAL_POLICY_REFUSED"),
  });
}

function admittedPolicy(value: unknown, requesterDigest: string, nowEpoch: number): AdmittedApprovalPolicy {
  const item = object(value, "APPROVAL_POLICY_REFUSED");
  exact(item, ["disposition", "policyRef", "requiredDecisions", "eligibleReviewerDigests", "expiresAt", "requesterMayReview"], "APPROVAL_POLICY_REFUSED");
  if (item.disposition !== "ADMITTED" || item.requesterMayReview !== false) throw new ControlError("APPROVAL_POLICY_REFUSED", 403);
  if (!Number.isSafeInteger(item.requiredDecisions) || Number(item.requiredDecisions) < 1 || Number(item.requiredDecisions) > 32) {
    throw new ControlError("APPROVAL_POLICY_REFUSED", 403);
  }
  if (!Array.isArray(item.eligibleReviewerDigests) || item.eligibleReviewerDigests.length < Number(item.requiredDecisions) || item.eligibleReviewerDigests.length > 32) {
    throw new ControlError("APPROVAL_POLICY_REFUSED", 403);
  }
  const reviewers = item.eligibleReviewerDigests.map((reviewer) => digest(reviewer, "APPROVAL_POLICY_REFUSED")).sort();
  if (new Set(reviewers).size !== reviewers.length || reviewers.includes(requesterDigest)) throw new ControlError("APPROVAL_POLICY_REFUSED", 403);
  if (typeof item.expiresAt !== "string" || epoch(item.expiresAt, "APPROVAL_POLICY_REFUSED") <= nowEpoch) {
    throw new ControlError("APPROVAL_POLICY_REFUSED", 403);
  }
  return Object.freeze({
    disposition: "ADMITTED",
    policyRef: policyRef(item.policyRef),
    requiredDecisions: Number(item.requiredDecisions),
    eligibleReviewerDigests: Object.freeze(reviewers),
    expiresAt: item.expiresAt,
    requesterMayReview: false,
  });
}

function transition(current: DemandState, next: DemandState): void {
  if (!DEMAND_TRANSITIONS[current].includes(next)) throw new ControlError("DEMAND_TRANSITION_REFUSED", 409);
}

function sourceMatches(left: DemandSourceReference, right: DemandSourceReference): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function mutationFingerprint(method: string, path: string, body: unknown): string {
  return sha256(canonicalJson({ method, path, body }));
}

export { mutationFingerprint };

export class DemandApprovalStore {
  private readonly demands = new Map<string, DemandRow>();
  private readonly approvals = new Map<string, ApprovalRow>();
  private readonly findings: DemandFinding[] = [];
  private readonly prerequisites: PrerequisiteDecisionRecord[] = [];
  private readonly audit: DemandAuditEvent[] = [];
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private auditFailure = false;

  constructor(
    private readonly sources: DemandSourceResolver,
    private readonly policy: ApprovalPolicyHook,
  ) {}

  failNextAuditForTest(): void {
    this.auditFailure = true;
  }

  private idempotencyIdentity(context: TenantContext, key: string): string {
    if (!IDEMPOTENCY_KEY.test(key)) throw new ControlError("IDEMPOTENCY_KEY_REFUSED", 400);
    return `${context.organizationId}:${sha256(key)}`;
  }

  private replay<T>(context: TenantContext, key: string, fingerprint: string): StoredResponse<T> | null {
    if (!SHA256.test(fingerprint)) throw new ControlError("REQUEST_FINGERPRINT_REFUSED", 400);
    const record = this.idempotency.get(this.idempotencyIdentity(context, key));
    if (!record) return null;
    if (record.fingerprint !== fingerprint) throw new ControlError("IDEMPOTENCY_KEY_CONFLICT", 409);
    return record.response as StoredResponse<T>;
  }

  private remember<T>(context: TenantContext, key: string, fingerprint: string, response: StoredResponse<T>): StoredResponse<T> {
    this.idempotency.set(this.idempotencyIdentity(context, key), Object.freeze({ fingerprint, response }));
    return response;
  }

  private commitAudit(events: readonly DemandAuditEvent[]): void {
    if (this.auditFailure) {
      this.auditFailure = false;
      throw new ControlError("AUDIT_APPEND_FAILED", 503);
    }
    this.audit.push(...events.map((event) => Object.freeze(event)));
  }

  private requireDemand(context: TenantContext, id: string): DemandRow {
    assertContext(context, "DEMAND_NOT_FOUND");
    const row = this.demands.get(`${context.organizationId}:${id}`);
    if (!row) throw new ControlError("DEMAND_NOT_FOUND", 404);
    return row;
  }

  private requireApproval(context: TenantContext, id: string): ApprovalRow {
    assertContext(context, "APPROVAL_NOT_FOUND");
    const row = this.approvals.get(`${context.organizationId}:${id}`);
    if (!row) throw new ControlError("APPROVAL_NOT_FOUND", 404);
    return row;
  }

  private demandFindings(context: TenantContext, id: string): readonly DemandFinding[] {
    return this.findings.filter((finding) => {
      const row = this.demands.get(`${context.organizationId}:${finding.demandId}`);
      return row?.id === id;
    });
  }

  private requireDemandEtag(row: DemandRow, supplied: string | null): void {
    if (!supplied) throw new ControlError("IF_MATCH_REQUIRED", 428);
    if (supplied !== demandEtag(row)) throw new ControlError("ETAG_PRECONDITION_FAILED", 412);
  }

  private requireApprovalEtag(row: ApprovalRow, supplied: string | null): void {
    if (!supplied) throw new ControlError("IF_MATCH_REQUIRED", 428);
    if (supplied !== approvalEtag(row)) throw new ControlError("ETAG_PRECONDITION_FAILED", 412);
  }

  create(
    context: TenantContext,
    inputValue: DemandCreateInput,
    idempotencyKey: string,
    fingerprint: string,
    nowEpoch: number,
  ): StoredResponse<DemandProjection> {
    assertContext(context, "DEMAND_NOT_FOUND");
    const replay = this.replay<DemandProjection>(context, idempotencyKey, fingerprint);
    if (replay) return replay;
    const input = validatedInput(inputValue);
    const now = timestamp(nowEpoch);
    const id = randomUUID();
    const row: DemandRow = Object.freeze({
      id,
      organizationId: context.organizationId,
      creatorDigest: context.subjectDigest,
      input,
      tenantDemand: tenantDemand(id, context.organizationId, input),
      state: "DRAFT",
      revision: 1,
      validatedResourceDigest: null,
      validatedRevision: null,
      approvalId: null,
      createdAt: now,
      updatedAt: now,
    });
    const event: DemandAuditEvent = Object.freeze({
      eventId: randomUUID(),
      organizationId: context.organizationId,
      actorDigest: context.subjectDigest,
      eventType: "demand.created.v1",
      aggregateId: id,
      aggregateDigest: demandDigest(row),
      occurredAt: now,
    });
    this.commitAudit([event]);
    this.demands.set(`${context.organizationId}:${id}`, row);
    this.prerequisites.push(...input.prerequisiteDecisions.map((decision) => Object.freeze({
      ...decision,
      organizationId: context.organizationId,
      demandId: id,
      revision: 1,
      actorDigest: context.subjectDigest,
      occurredAt: now,
    })));
    const response = Object.freeze({ status: 201, body: demandProjection(row, []), etag: demandEtag(row) });
    return this.remember(context, idempotencyKey, fingerprint, response);
  }

  readDemand(context: TenantContext, id: string): StoredResponse<DemandProjection> {
    const row = this.requireDemand(context, id);
    return Object.freeze({ status: 200, body: demandProjection(row, this.demandFindings(context, id)), etag: demandEtag(row) });
  }

  validate(
    context: TenantContext,
    id: string,
    ifMatch: string | null,
    idempotencyKey: string,
    fingerprint: string,
    nowEpoch: number,
  ): StoredResponse<DemandProjection> {
    const replay = this.replay<DemandProjection>(context, idempotencyKey, fingerprint);
    if (replay) return replay;
    const current = this.requireDemand(context, id);
    this.requireDemandEtag(current, ifMatch);
    if (TERMINAL_DEMAND.has(current.state) || (current.state !== "DRAFT" && current.state !== "BLOCKED")) {
      throw new ControlError("DEMAND_VALIDATION_STATE_REFUSED", 409);
    }
    const now = timestamp(nowEpoch);
    const revision = current.revision + 1;
    const nextFindings: DemandFinding[] = [];
    const appendFinding = (reason: DemandFinding["reasonCode"], subjectId: string): void => {
      nextFindings.push(Object.freeze({
        findingId: sha256(canonicalJson({ id, revision, reason, subjectId })),
        demandId: id,
        revision,
        severity: reason === "DEMAND_VALIDATED" ? "PASS" : "BLOCKING",
        reasonCode: reason,
        subjectId,
        occurredAt: now,
      }));
    };
    const resolution = this.sources.resolve(context.organizationId, current.input.source);
    if (resolution.availability !== "AVAILABLE") {
      appendFinding("SOURCE_UNAVAILABLE", current.input.source.questionnaireSessionId);
    } else {
      const source = resolution.source;
      const comparable: DemandSourceReference = {
        questionnaireSessionId: source.questionnaireSessionId,
        questionnaireSessionRevision: source.questionnaireSessionRevision,
        questionnaireAnswerSetId: source.questionnaireAnswerSetId,
        questionnaireAnswerSetDigest: source.questionnaireAnswerSetDigest,
        readinessAssessmentId: source.readinessAssessmentId,
        readinessAssessmentDigest: source.readinessAssessmentDigest,
      };
      if (source.organizationId !== context.organizationId || !sourceMatches(current.input.source, comparable)) {
        appendFinding("SOURCE_REFERENCE_MISMATCH", current.input.source.questionnaireSessionId);
      }
      if (source.questionnaireState !== "READY_FOR_COMPILATION") appendFinding("QUESTIONNAIRE_NOT_READY", source.questionnaireSessionId);
      if (source.readinessStatus !== "PASS") appendFinding("READINESS_NOT_PASS", source.readinessAssessmentId);
      if (epoch(source.readinessExpiresAt, "DEMAND_SOURCE_TIMESTAMP_REFUSED") <= nowEpoch) appendFinding("READINESS_EXPIRED", source.readinessAssessmentId);
      if (!source.ownerApprovalId || !source.ownerApprovalDigest || !source.ownerApprovalExpiresAt) {
        appendFinding("OWNER_APPROVAL_MISSING", source.readinessAssessmentId);
      } else {
        stableId(source.ownerApprovalId, "DEMAND_SOURCE_REFUSED");
        digest(source.ownerApprovalDigest, "DEMAND_SOURCE_REFUSED");
        if (epoch(source.ownerApprovalExpiresAt, "DEMAND_SOURCE_TIMESTAMP_REFUSED") <= nowEpoch) {
          appendFinding("OWNER_APPROVAL_EXPIRED", source.ownerApprovalId);
        }
      }
      if (source.environmentAttestationDigest !== current.input.environment.attestationDigest) {
        appendFinding("ENVIRONMENT_ATTESTATION_MISMATCH", "environment.attestation");
      }
    }
    for (const decision of current.input.prerequisiteDecisions) {
      if (decision.decision === "REJECT") appendFinding("PREREQUISITE_REJECTED", decision.harnessId);
    }
    nextFindings.sort((left, right) => left.reasonCode.localeCompare(right.reasonCode) || left.subjectId.localeCompare(right.subjectId));
    if (nextFindings.length === 0) appendFinding("DEMAND_VALIDATED", current.tenantDemand.metadata.id);
    const nextState: DemandState = nextFindings.some((finding) => finding.severity === "BLOCKING") ? "BLOCKED" : "VALIDATED";
    if (nextState !== current.state) transition(current.state, nextState);
    const resourceDigest = sha256(canonicalJson(current.tenantDemand));
    const next: DemandRow = Object.freeze({
      ...current,
      state: nextState,
      revision,
      validatedResourceDigest: nextState === "VALIDATED" ? resourceDigest : null,
      validatedRevision: nextState === "VALIDATED" ? revision : null,
      updatedAt: now,
    });
    const event: DemandAuditEvent = Object.freeze({
      eventId: randomUUID(),
      organizationId: context.organizationId,
      actorDigest: context.subjectDigest,
      eventType: "demand.validated.v1",
      aggregateId: id,
      aggregateDigest: demandDigest(next),
      occurredAt: now,
    });
    this.commitAudit([event]);
    this.demands.set(`${context.organizationId}:${id}`, next);
    this.findings.push(...nextFindings);
    const response = Object.freeze({
      status: 200,
      body: demandProjection(next, this.demandFindings(context, id)),
      etag: demandEtag(next),
    });
    return this.remember(context, idempotencyKey, fingerprint, response);
  }

  requestApproval(
    context: TenantContext,
    demandIdValue: string,
    ifMatch: string | null,
    idempotencyKey: string,
    fingerprint: string,
    nowEpoch: number,
  ): StoredResponse<ApprovalProjection> {
    const replay = this.replay<ApprovalProjection>(context, idempotencyKey, fingerprint);
    if (replay) return replay;
    const current = this.requireDemand(context, demandIdValue);
    this.requireDemandEtag(current, ifMatch);
    if (current.state !== "VALIDATED" || !current.validatedResourceDigest || current.validatedRevision !== current.revision) {
      throw new ControlError("DEMAND_APPROVAL_STATE_REFUSED", 409);
    }
    const request: PolicyAdmissionRequest = Object.freeze({
      organizationId: context.organizationId,
      requesterDigest: context.subjectDigest,
      demandId: current.id,
      demandRevision: current.validatedRevision,
      demandDigest: current.validatedResourceDigest,
      nowEpoch,
    });
    const result = this.policy.evaluate(request);
    if (result.disposition === "UNAVAILABLE") throw new ControlError("APPROVAL_POLICY_UNAVAILABLE", 503);
    if (result.disposition === "DENIED") throw new ControlError("APPROVAL_POLICY_DENIED", 403);
    const admitted = admittedPolicy(result, context.subjectDigest, nowEpoch);
    const now = timestamp(nowEpoch);
    const approvalId = randomUUID();
    const approval: ApprovalRow = Object.freeze({
      id: approvalId,
      organizationId: context.organizationId,
      demandId: current.id,
      demandRevision: current.validatedRevision,
      demandDigest: current.validatedResourceDigest,
      requesterDigest: context.subjectDigest,
      policyRequest: request,
      policy: admitted,
      policyBindingDigest: sha256(canonicalJson(admitted)),
      state: "PENDING",
      revision: 1,
      decisions: Object.freeze([]),
      reasonCode: null,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    transition(current.state, "APPROVAL_PENDING");
    const demand: DemandRow = Object.freeze({
      ...current,
      state: "APPROVAL_PENDING",
      revision: current.revision + 1,
      approvalId,
      updatedAt: now,
    });
    this.commitAudit([
      Object.freeze({
        eventId: randomUUID(), organizationId: context.organizationId, actorDigest: context.subjectDigest,
        eventType: "approval.requested.v1", aggregateId: approvalId, aggregateDigest: approvalDigest(approval), occurredAt: now,
      }),
      Object.freeze({
        eventId: randomUUID(), organizationId: context.organizationId, actorDigest: context.subjectDigest,
        eventType: "demand.approval-pending.v1", aggregateId: current.id, aggregateDigest: demandDigest(demand), occurredAt: now,
      }),
    ]);
    this.approvals.set(`${context.organizationId}:${approvalId}`, approval);
    this.demands.set(`${context.organizationId}:${current.id}`, demand);
    const response = Object.freeze({ status: 201, body: approvalProjection(approval), etag: approvalEtag(approval) });
    return this.remember(context, idempotencyKey, fingerprint, response);
  }

  readApproval(context: TenantContext, id: string): StoredResponse<ApprovalProjection> {
    const row = this.requireApproval(context, id);
    return Object.freeze({ status: 200, body: approvalProjection(row), etag: approvalEtag(row) });
  }

  decide(
    context: TenantContext,
    id: string,
    input: { readonly decision: "APPROVE" | "REJECT"; readonly reasonCode: string },
    ifMatch: string | null,
    idempotencyKey: string,
    fingerprint: string,
    nowEpoch: number,
  ): StoredResponse<ApprovalProjection> {
    const replay = this.replay<ApprovalProjection>(context, idempotencyKey, fingerprint);
    if (replay) return replay;
    const current = this.requireApproval(context, id);
    this.requireApprovalEtag(current, ifMatch);
    if (TERMINAL_APPROVAL.has(current.state) || current.state !== "PENDING") throw new ControlError("APPROVAL_TERMINAL", 409);
    if ((input.decision !== "APPROVE" && input.decision !== "REJECT") || Object.keys(input).length !== 2) {
      throw new ControlError("APPROVAL_DECISION_REFUSED", 422);
    }
    const acceptedReason = reasonCode(input.reasonCode, "APPROVAL_DECISION_REFUSED");
    if (current.requesterDigest === context.subjectDigest) throw new ControlError("APPROVAL_SELF_REVIEW_REFUSED", 403);
    if (!current.policy.eligibleReviewerDigests.includes(context.subjectDigest)) throw new ControlError("APPROVAL_REVIEWER_REFUSED", 403);
    if (current.decisions.some((decision) => decision.actorDigest === context.subjectDigest)) {
      throw new ControlError("APPROVAL_DUPLICATE_REVIEWER", 409);
    }
    const demand = this.requireDemand(context, current.demandId);
    if (
      demand.state !== "APPROVAL_PENDING" || demand.validatedResourceDigest !== current.demandDigest ||
      demand.validatedRevision !== current.demandRevision || demand.approvalId !== current.id
    ) {
      throw new ControlError("APPROVAL_SUBJECT_STALE", 409);
    }
    const reevaluated = this.policy.evaluate(Object.freeze({ ...current.policyRequest, nowEpoch }));
    if (reevaluated.disposition === "UNAVAILABLE") throw new ControlError("APPROVAL_POLICY_UNAVAILABLE", 503);
    if (reevaluated.disposition === "DENIED") throw new ControlError("APPROVAL_POLICY_DENIED", 403);
    const currentPolicy = admittedPolicy(reevaluated, current.requesterDigest, current.policyRequest.nowEpoch);
    if (sha256(canonicalJson(currentPolicy)) !== current.policyBindingDigest) throw new ControlError("APPROVAL_POLICY_STALE", 409);
    const now = timestamp(nowEpoch);
    if (epoch(current.policy.expiresAt, "APPROVAL_POLICY_REFUSED") <= nowEpoch) {
      const expired: ApprovalRow = Object.freeze({ ...current, state: "EXPIRED", revision: current.revision + 1, reasonCode: "APPROVAL_EXPIRED", updatedAt: now });
      transition(demand.state, "BLOCKED");
      const blocked: DemandRow = Object.freeze({ ...demand, state: "BLOCKED", revision: demand.revision + 1, approvalId: null, updatedAt: now });
      const finding: DemandFinding = Object.freeze({
        findingId: sha256(canonicalJson({ demandId: demand.id, revision: blocked.revision, reasonCode: "APPROVAL_EXPIRED" })),
        demandId: demand.id,
        revision: blocked.revision,
        severity: "BLOCKING",
        reasonCode: "APPROVAL_EXPIRED",
        subjectId: current.id,
        occurredAt: now,
      });
      this.commitAudit([
        Object.freeze({ eventId: randomUUID(), organizationId: context.organizationId, actorDigest: context.subjectDigest, eventType: "approval.expired.v1", aggregateId: id, aggregateDigest: approvalDigest(expired), occurredAt: now }),
        Object.freeze({ eventId: randomUUID(), organizationId: context.organizationId, actorDigest: context.subjectDigest, eventType: "demand.blocked.v1", aggregateId: demand.id, aggregateDigest: demandDigest(blocked), occurredAt: now }),
      ]);
      this.approvals.set(`${context.organizationId}:${id}`, expired);
      this.demands.set(`${context.organizationId}:${demand.id}`, blocked);
      this.findings.push(finding);
      const response = Object.freeze({ status: 409, body: approvalProjection(expired), etag: approvalEtag(expired) });
      return this.remember(context, idempotencyKey, fingerprint, response);
    }
    const decision: ApprovalDecisionRecord = Object.freeze({
      actor: Object.freeze({ type: "HUMAN", id: actorId(context.subjectDigest) }),
      actorDigest: context.subjectDigest,
      decision: input.decision,
      decidedAt: now,
      reasonCode: acceptedReason,
    });
    const decisions = Object.freeze([...current.decisions, decision]);
    const approvals = decisions.filter((item) => item.decision === "APPROVE").length;
    const nextState: ApprovalState = input.decision === "REJECT"
      ? "REJECTED"
      : approvals >= current.policy.requiredDecisions ? "APPROVED" : "PENDING";
    const approval: ApprovalRow = Object.freeze({
      ...current,
      state: nextState,
      revision: current.revision + 1,
      decisions,
      reasonCode: nextState === "APPROVED" ? "QUORUM_REACHED" : nextState === "REJECTED" ? acceptedReason : null,
      updatedAt: now,
    });
    let nextDemand = demand;
    const events: DemandAuditEvent[] = [Object.freeze({
      eventId: randomUUID(), organizationId: context.organizationId, actorDigest: context.subjectDigest,
      eventType: "approval.decision-recorded.v1", aggregateId: id, aggregateDigest: approvalDigest(approval), occurredAt: now,
    })];
    if (nextState === "APPROVED" || nextState === "REJECTED") {
      transition(demand.state, nextState);
      nextDemand = Object.freeze({ ...demand, state: nextState, revision: demand.revision + 1, updatedAt: now });
      events.push(Object.freeze({
        eventId: randomUUID(), organizationId: context.organizationId, actorDigest: context.subjectDigest,
        eventType: nextState === "APPROVED" ? "demand.approved.v1" : "demand.rejected.v1",
        aggregateId: demand.id, aggregateDigest: demandDigest(nextDemand), occurredAt: now,
      }));
    }
    this.commitAudit(events);
    this.approvals.set(`${context.organizationId}:${id}`, approval);
    this.demands.set(`${context.organizationId}:${demand.id}`, nextDemand);
    const response = Object.freeze({ status: 200, body: approvalProjection(approval), etag: approvalEtag(approval) });
    return this.remember(context, idempotencyKey, fingerprint, response);
  }

  demandAuditEvents(context: TenantContext, id: string): readonly DemandAuditEvent[] {
    this.requireDemand(context, id);
    return Object.freeze(this.audit.filter((event) => event.organizationId === context.organizationId && event.aggregateId === id));
  }

  approvalAuditEvents(context: TenantContext, id: string): readonly DemandAuditEvent[] {
    this.requireApproval(context, id);
    return Object.freeze(this.audit.filter((event) => event.organizationId === context.organizationId && event.aggregateId === id));
  }

  prerequisiteDecisionRecords(context: TenantContext, id: string): readonly PrerequisiteDecisionRecord[] {
    this.requireDemand(context, id);
    return Object.freeze(this.prerequisites.filter((decision) => decision.organizationId === context.organizationId && decision.demandId === id));
  }
}
