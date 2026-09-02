import { randomUUID } from "node:crypto";

import { canonicalJson, sha256 } from "../foundation/canonical";
import { ControlError, type TenantContext } from "../foundation/contracts";
import type { DemandProjection, ResourceRef, StoredResponse } from "../demands/contracts";
import type {
  CompileInputResolver,
  DemandReader,
  HarnessOperationEvent,
  OperationAuditEvent,
  OperationFailure,
  OperationResource,
  OperationState,
  QueuedCompilationJob,
  ResolvedCompileInput,
} from "./contracts";
import { COMPILER_AUTHORITY, HARNESS_API_VERSION, OPERATION_SCHEMA } from "./contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u;
const REASON_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;

interface OperationRow {
  readonly id: string;
  readonly organizationId: string;
  readonly state: OperationState;
  readonly revision: number;
  readonly demandId: string;
  readonly demandRevision: number;
  readonly demandDigest: string;
  readonly actorDigest: string;
  readonly idempotencyKeyDigest: string;
  readonly correlationId: string;
  readonly requestedAt: string;
  readonly updatedAt: string;
  readonly resultRefs: readonly ResourceRef[];
  readonly failure: OperationFailure | null;
}

interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly response: StoredResponse<OperationResource>;
}

const TRANSITIONS = Object.freeze<Record<OperationState, readonly OperationState[]>>({
  PENDING: Object.freeze(["RUNNING", "CANCELLED"]),
  RUNNING: Object.freeze(["SUCCEEDED", "FAILED", "CANCELLING"]),
  CANCELLING: Object.freeze(["CANCELLED", "FAILED"]),
  SUCCEEDED: Object.freeze([]),
  FAILED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
});

function timestamp(nowEpoch: number): string {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) throw new ControlError("OPERATION_TIME_REFUSED", 500);
  return new Date(nowEpoch * 1000).toISOString().replace(".000Z", "Z");
}

function tenantId(organizationId: string): string {
  return `tenant.${organizationId.replaceAll("-", "")}`;
}

function actorId(subjectDigest: string): string {
  return `actor.${subjectDigest.slice("sha256:".length)}`;
}

function assertContext(context: TenantContext): void {
  if (!UUID.test(context.organizationId) || !SHA256.test(context.subjectDigest)) {
    throw new ControlError("OPERATION_NOT_FOUND", 404);
  }
}

function assertResolved(demand: DemandProjection, organizationId: string, input: ResolvedCompileInput): void {
  const expectedInputDigest = sha256(canonicalJson({
    compileRequest: input.compileRequest,
    catalogResources: input.catalogResources,
    catalogDigest: input.catalogDigest,
  }));
  const requestMetadata = input.compileRequest.metadata;
  const request = requestMetadata && typeof requestMetadata === "object" && !Array.isArray(requestMetadata)
    ? requestMetadata as Record<string, unknown>
    : {};
  if (
    input.organizationId !== organizationId || input.demandId !== demand.id ||
    input.demandRevision !== demand.revision || input.demandDigest !== demand.digest ||
    input.questionnaireAnswerSetId !== demand.source.questionnaireAnswerSetId ||
    input.questionnaireAnswerSetDigest !== demand.source.questionnaireAnswerSetDigest ||
    input.readinessAssessmentId !== demand.source.readinessAssessmentId ||
    input.readinessAssessmentDigest !== demand.source.readinessAssessmentDigest ||
    input.environmentAttestationDigest !== demand.tenantDemand.spec.environment.attestationDigest ||
    input.catalogResources.length === 0 || !SHA256.test(input.catalogDigest) ||
    input.inputDigest !== expectedInputDigest || request.demandId !== demand.tenantDemand.metadata.id ||
    request.tenantId !== demand.tenantDemand.spec.tenantId
  ) {
    throw new ControlError("COMPILE_INPUT_STALE", 409);
  }
}

function resource(row: OperationRow): OperationResource {
  return Object.freeze({
    apiVersion: HARNESS_API_VERSION,
    kind: "Operation",
    metadata: Object.freeze({ id: row.id, version: `0.1.${row.revision - 1}` }),
    spec: Object.freeze({
      organizationId: tenantId(row.organizationId),
      operationType: "COMPILE_PROFILE",
      state: row.state,
      subject: Object.freeze({ kind: "tenant-demand", id: `demand.${row.demandId.replaceAll("-", "")}`, digest: row.demandDigest }),
      actor: Object.freeze({ type: "HUMAN", id: actorId(row.actorDigest) }),
      idempotencyKeyDigest: row.idempotencyKeyDigest,
      requestedAt: row.requestedAt,
      updatedAt: row.updatedAt,
      observedVersion: row.revision,
      cancellable: false,
      resultRefs: Object.freeze(row.resultRefs.map((reference) => Object.freeze({ ...reference }))),
      failure: row.failure ? Object.freeze({ ...row.failure, evidenceRefs: Object.freeze([...row.failure.evidenceRefs]) }) : null,
    }),
  });
}

function etag(row: OperationRow): string {
  return `"${sha256(canonicalJson(resource(row))).slice("sha256:".length)}"`;
}

function response(row: OperationRow, status: number): StoredResponse<OperationResource> {
  return Object.freeze({ status, body: resource(row), etag: etag(row) });
}

function event(row: OperationRow, previous: OperationState, reasonCode: string): HarnessOperationEvent {
  return Object.freeze({
    specversion: "1.0",
    id: randomUUID(),
    source: "urn:planeon:harness:control.profile-compiler",
    type: "harness.operation.state.changed.v1",
    subject: row.id,
    time: row.updatedAt,
    datacontenttype: "application/json",
    dataschema: "https://harness.planeon.ai/schemas/v1alpha1/events/harness-cloud-event.schema.json",
    organizationid: tenantId(row.organizationId),
    partitionkey: tenantId(row.organizationId),
    sequence: row.revision,
    data: Object.freeze({
      schemaVersion: "harness.planeon.ai/event-data/v1alpha1",
      aggregateKind: "Operation",
      aggregateId: row.id,
      aggregateVersion: row.revision,
      actor: Object.freeze({ type: "WORKLOAD", id: "worker.profile-compiler" }),
      correlationId: row.correlationId,
      causationId: null,
      reasonCode,
      transition: Object.freeze({ from: previous, to: row.state }),
      resourceRefs: Object.freeze(row.resultRefs.map((reference) => Object.freeze({ ...reference }))),
      evidenceRefs: Object.freeze([]) as readonly [],
    }),
  });
}

export function operationMutationFingerprint(method: string, path: string, body: unknown): string {
  return sha256(canonicalJson({ method, path, body }));
}

export class OperationStore {
  private readonly operations = new Map<string, OperationRow>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly jobs: QueuedCompilationJob[] = [];
  private readonly audit: OperationAuditEvent[] = [];
  private readonly outbox: HarnessOperationEvent[] = [];
  private failAudit = false;

  constructor(private readonly demands: DemandReader, private readonly resolver: CompileInputResolver) {}

  failNextAuditForTest(): void {
    this.failAudit = true;
  }

  requestCompilation(
    context: TenantContext,
    demandId: string,
    ifMatch: string | null,
    idempotencyKey: string,
    fingerprint: string,
    nowEpoch: number,
  ): StoredResponse<OperationResource> {
    assertContext(context);
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new ControlError("IDEMPOTENCY_KEY_REFUSED", 400);
    if (!SHA256.test(fingerprint)) throw new ControlError("REQUEST_FINGERPRINT_REFUSED", 400);
    const idempotencyIdentity = `${context.organizationId}:${sha256(idempotencyKey)}`;
    const remembered = this.idempotency.get(idempotencyIdentity);
    if (remembered) {
      if (remembered.fingerprint !== fingerprint) throw new ControlError("IDEMPOTENCY_CONFLICT", 409);
      return remembered.response;
    }
    if (ifMatch === null) throw new ControlError("PRECONDITION_REQUIRED", 428);
    const demandResponse = this.demands.readDemand(context, demandId);
    if (demandResponse.etag !== ifMatch) throw new ControlError("PRECONDITION_FAILED", 412);
    const demand = demandResponse.body;
    if (demand.state !== "APPROVED") throw new ControlError("DEMAND_NOT_APPROVED", 409);
    const resolution = this.resolver.resolve(context.organizationId, demand);
    if (resolution.availability === "UNAVAILABLE") throw new ControlError("COMPILE_INPUT_UNAVAILABLE", 503);
    if (resolution.availability === "NOT_FOUND") throw new ControlError("COMPILE_INPUT_NOT_FOUND", 404);
    assertResolved(demand, context.organizationId, resolution.input);

    const now = timestamp(nowEpoch);
    const operationId = `operation.${randomUUID().replaceAll("-", "")}`;
    const row: OperationRow = Object.freeze({
      id: operationId,
      organizationId: context.organizationId,
      state: "PENDING",
      revision: 1,
      demandId: demand.id,
      demandRevision: demand.revision,
      demandDigest: demand.digest,
      actorDigest: context.subjectDigest,
      idempotencyKeyDigest: sha256(idempotencyKey),
      correlationId: randomUUID(),
      requestedAt: now,
      updatedAt: now,
      resultRefs: Object.freeze([]),
      failure: null,
    });
    const job: QueuedCompilationJob = Object.freeze({
      schemaVersion: OPERATION_SCHEMA,
      id: `job.${randomUUID().replaceAll("-", "")}`,
      organizationId: context.organizationId,
      operationId,
      state: "QUEUED",
      demandId: demand.id,
      demandRevision: demand.revision,
      demandDigest: demand.digest,
      inputDigest: resolution.input.inputDigest,
      catalogDigest: resolution.input.catalogDigest,
      compilerWheelDigest: `sha256:${COMPILER_AUTHORITY.compilerWheelSha256}`,
      compileRequest: Object.freeze({ ...resolution.input.compileRequest }),
      catalogResources: Object.freeze(
        resolution.input.catalogResources.map((catalogResource) => Object.freeze({ ...catalogResource })),
      ),
      attempt: 0,
      availableAt: now,
      createdAt: now,
    });
    const audit: OperationAuditEvent = Object.freeze({
      eventId: randomUUID(),
      organizationId: context.organizationId,
      eventType: "profile.compilation.requested.v1",
      aggregateId: operationId,
      aggregateDigest: sha256(canonicalJson(resource(row))),
      actorDigest: context.subjectDigest,
      occurredAt: now,
    });
    if (this.failAudit) {
      this.failAudit = false;
      throw new ControlError("AUDIT_WRITE_REFUSED", 500);
    }
    const result = response(row, 202);
    this.operations.set(`${context.organizationId}:${operationId}`, row);
    this.jobs.push(job);
    this.audit.push(audit);
    this.idempotency.set(idempotencyIdentity, Object.freeze({ fingerprint, response: result }));
    return result;
  }

  readOperation(context: TenantContext, operationId: string): StoredResponse<OperationResource> {
    assertContext(context);
    const row = this.operations.get(`${context.organizationId}:${operationId}`);
    if (!row) throw new ControlError("OPERATION_NOT_FOUND", 404);
    return response(row, 200);
  }

  applyWorkerTransition(
    organizationId: string,
    operationId: string,
    next: OperationState,
    reasonCode: string,
    nowEpoch: number,
    resultRefs: readonly ResourceRef[] = [],
    failure: OperationFailure | null = null,
  ): OperationResource {
    const key = `${organizationId}:${operationId}`;
    const current = this.operations.get(key);
    if (!current) throw new ControlError("OPERATION_NOT_FOUND", 404);
    if (!TRANSITIONS[current.state].includes(next) || !REASON_CODE.test(reasonCode)) {
      throw new ControlError("OPERATION_TRANSITION_REFUSED", 409);
    }
    if ((next === "FAILED") !== (failure !== null)) throw new ControlError("OPERATION_FAILURE_REFUSED", 422);
    if (next !== "SUCCEEDED" && resultRefs.length > 0) throw new ControlError("OPERATION_RESULT_REFUSED", 422);
    if (resultRefs.some((reference) => !STABLE_ID.test(reference.kind) || !STABLE_ID.test(reference.id) || !SHA256.test(reference.digest))) {
      throw new ControlError("OPERATION_RESULT_REFUSED", 422);
    }
    const changed: OperationRow = Object.freeze({
      ...current,
      state: next,
      revision: current.revision + 1,
      updatedAt: timestamp(nowEpoch),
      resultRefs: Object.freeze(resultRefs.map((reference) => Object.freeze({ ...reference }))),
      failure,
    });
    const emitted = event(changed, current.state, reasonCode);
    const audit: OperationAuditEvent = Object.freeze({
      eventId: randomUUID(), organizationId, eventType: "harness.operation.state.changed.v1",
      aggregateId: operationId, aggregateDigest: sha256(canonicalJson(resource(changed))),
      actorDigest: sha256("worker.profile-compiler"), occurredAt: changed.updatedAt,
    });
    if (this.failAudit) {
      this.failAudit = false;
      throw new ControlError("AUDIT_WRITE_REFUSED", 500);
    }
    this.operations.set(key, changed);
    this.outbox.push(emitted);
    this.audit.push(audit);
    return resource(changed);
  }

  queuedJobs(organizationId: string): readonly QueuedCompilationJob[] {
    return Object.freeze(this.jobs.filter((job) => job.organizationId === organizationId));
  }

  auditEvents(organizationId: string): readonly OperationAuditEvent[] {
    return Object.freeze(this.audit.filter((item) => item.organizationId === organizationId));
  }

  outboxEvents(organizationId: string): readonly HarnessOperationEvent[] {
    return Object.freeze(this.outbox.filter((item) => item.organizationid === tenantId(organizationId)));
  }
}
