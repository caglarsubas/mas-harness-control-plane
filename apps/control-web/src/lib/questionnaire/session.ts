import { randomUUID } from "node:crypto";

import { canonicalJson, sha256 } from "../foundation/canonical";
import { ControlError, type TenantContext } from "../foundation/contracts";
import {
  JOURNEY_STAGES,
  QUESTIONNAIRE_SCHEMA,
  type AdmittedIndustryPack,
  type AnswerRevision,
  type AnswerValue,
  type AuditEvent,
  type QuestionDefinition,
  type QuestionnaireSessionProjection,
  type QuestionnaireState,
  type ReadinessFinding,
  type StageId,
  type StoredMutationResponse,
  type TenantAnswer,
} from "./contracts";
import { AdmittedIndustryPackRegistry } from "./pack";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CREDENTIAL = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:api[_-]?key|password|secret|token)\s*[:=]|\bsk-[A-Za-z0-9]{20,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/iu;

interface SessionRow {
  readonly id: string;
  readonly organizationId: string;
  readonly actorDigest: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly packDigest: string;
  readonly state: QuestionnaireState;
  readonly currentStageId: StageId;
  readonly completedStageIds: readonly StageId[];
  readonly revision: number;
  readonly answers: ReadonlyMap<string, TenantAnswer>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly response: StoredMutationResponse<QuestionnaireSessionProjection>;
}

function timestamp(nowEpoch: number): string {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) throw new ControlError("QUESTIONNAIRE_TIME_REFUSED", 500);
  return new Date(nowEpoch * 1000).toISOString().replace(".000Z", "Z");
}

function etag(row: SessionRow): string {
  return `"${sha256(canonicalJson({ id: row.id, revision: row.revision, packDigest: row.packDigest })).slice(7)}"`;
}

function missing(value: AnswerValue | undefined): boolean {
  return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function questionMap(pack: AdmittedIndustryPack): ReadonlyMap<string, { stageId: StageId; question: QuestionDefinition }> {
  const result = new Map<string, { stageId: StageId; question: QuestionDefinition }>();
  for (const stage of pack.stages) {
    for (const question of stage.questions) result.set(question.id, { stageId: stage.id, question });
  }
  return result;
}

function credentialShaped(value: AnswerValue): boolean {
  return typeof value === "string" ? CREDENTIAL.test(value) : Array.isArray(value) && value.some((item) => CREDENTIAL.test(item));
}

function validatedAnswer(question: QuestionDefinition, value: unknown): AnswerValue {
  let answer: AnswerValue;
  if (question.responseType === "string") {
    if (typeof value !== "string" || value.length > 4_096 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) {
      throw new ControlError("QUESTIONNAIRE_ANSWER_TYPE_REFUSED", 422);
    }
    answer = value;
  } else if (question.responseType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new ControlError("QUESTIONNAIRE_ANSWER_TYPE_REFUSED", 422);
    }
    answer = value;
  } else if (question.responseType === "boolean") {
    if (typeof value !== "boolean") throw new ControlError("QUESTIONNAIRE_ANSWER_TYPE_REFUSED", 422);
    answer = value;
  } else if (question.responseType === "single-choice") {
    if (typeof value !== "string" || !question.options.includes(value)) throw new ControlError("QUESTIONNAIRE_CHOICE_REFUSED", 422);
    answer = value;
  } else {
    if (
      !Array.isArray(value) || value.length < 1 || value.length > 64 ||
      !value.every((item) => typeof item === "string" && question.options.includes(item)) ||
      value.length !== new Set(value).size
    ) {
      throw new ControlError("QUESTIONNAIRE_CHOICE_REFUSED", 422);
    }
    answer = Object.freeze([...value] as string[]);
  }
  if (credentialShaped(answer)) throw new ControlError("QUESTIONNAIRE_CREDENTIAL_VALUE_REFUSED", 422);
  return answer;
}

function frozenProjection(row: SessionRow, findings: readonly ReadinessFinding[]): QuestionnaireSessionProjection {
  return Object.freeze({
    schemaVersion: QUESTIONNAIRE_SCHEMA,
    id: row.id,
    packId: row.packId,
    packVersion: row.packVersion,
    packDigest: row.packDigest,
    state: row.state,
    currentStageId: row.currentStageId,
    completedStageIds: Object.freeze([...row.completedStageIds]),
    revision: row.revision,
    answers: Object.freeze([...row.answers.values()].sort((left, right) => left.questionId.localeCompare(right.questionId))),
    findings: Object.freeze([...findings]),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function assertContext(context: TenantContext): void {
  if (!UUID.test(context.organizationId) || !/^sha256:[0-9a-f]{64}$/u.test(context.subjectDigest)) {
    throw new ControlError("QUESTIONNAIRE_SESSION_NOT_FOUND", 404);
  }
}

export function mutationFingerprint(method: string, path: string, body: unknown): string {
  return sha256(canonicalJson({ method, path, body }));
}

export class QuestionnaireSessionStore {
  private readonly rows = new Map<string, SessionRow>();
  private readonly answerHistory: AnswerRevision[] = [];
  private readonly findingHistory: ReadinessFinding[] = [];
  private readonly audit: AuditEvent[] = [];
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private auditFailure = false;

  constructor(private readonly packs: AdmittedIndustryPackRegistry) {}

  failNextAuditForTest(): void {
    this.auditFailure = true;
  }

  private idempotencyKey(context: TenantContext, key: string): string {
    if (!IDEMPOTENCY_KEY.test(key)) throw new ControlError("IDEMPOTENCY_KEY_REFUSED", 400);
    return `${context.organizationId}:${sha256(key)}`;
  }

  private replay(
    context: TenantContext,
    key: string,
    fingerprint: string,
  ): StoredMutationResponse<QuestionnaireSessionProjection> | null {
    if (!/^sha256:[0-9a-f]{64}$/u.test(fingerprint)) throw new ControlError("REQUEST_FINGERPRINT_REFUSED", 400);
    const record = this.idempotency.get(this.idempotencyKey(context, key));
    if (!record) return null;
    if (record.fingerprint !== fingerprint) throw new ControlError("IDEMPOTENCY_KEY_CONFLICT", 409);
    return record.response;
  }

  private remember(
    context: TenantContext,
    key: string,
    fingerprint: string,
    response: StoredMutationResponse<QuestionnaireSessionProjection>,
  ): StoredMutationResponse<QuestionnaireSessionProjection> {
    this.idempotency.set(this.idempotencyKey(context, key), Object.freeze({ fingerprint, response }));
    return response;
  }

  private requireRow(context: TenantContext, id: string): SessionRow {
    assertContext(context);
    const row = this.rows.get(`${context.organizationId}:${id}`);
    if (!row) throw new ControlError("QUESTIONNAIRE_SESSION_NOT_FOUND", 404);
    return row;
  }

  private findings(context: TenantContext, id: string): readonly ReadinessFinding[] {
    return this.findingHistory.filter((finding) => finding.organizationId === context.organizationId && finding.sessionId === id);
  }

  private requireEtag(row: SessionRow, supplied: string | null): void {
    if (!supplied) throw new ControlError("IF_MATCH_REQUIRED", 428);
    if (supplied !== etag(row)) throw new ControlError("ETAG_PRECONDITION_FAILED", 412);
  }

  private commitAudit(event: AuditEvent): void {
    if (this.auditFailure) {
      this.auditFailure = false;
      throw new ControlError("AUDIT_APPEND_FAILED", 503);
    }
    this.audit.push(Object.freeze(event));
  }

  create(
    context: TenantContext,
    input: { readonly packId: string; readonly packVersion: string },
    idempotencyKey: string,
    fingerprint: string,
    nowEpoch: number,
  ): StoredMutationResponse<QuestionnaireSessionProjection> {
    assertContext(context);
    const replay = this.replay(context, idempotencyKey, fingerprint);
    if (replay) return replay;
    const pack = this.packs.require(input.packId, input.packVersion);
    const now = timestamp(nowEpoch);
    const id = randomUUID();
    const row: SessionRow = Object.freeze({
      id,
      organizationId: context.organizationId,
      actorDigest: context.subjectDigest,
      packId: pack.packId,
      packVersion: pack.packVersion,
      packDigest: pack.releaseDigest,
      state: "DRAFT",
      currentStageId: JOURNEY_STAGES[0].id,
      completedStageIds: Object.freeze([]),
      revision: 1,
      answers: new Map(),
      createdAt: now,
      updatedAt: now,
    });
    const event = Object.freeze({
      eventId: randomUUID(),
      organizationId: context.organizationId,
      actorDigest: context.subjectDigest,
      eventType: "questionnaire.session.created.v1",
      aggregateId: id,
      aggregateDigest: sha256(canonicalJson({ id, revision: 1, packDigest: pack.releaseDigest, state: "DRAFT" })),
      occurredAt: now,
    });
    this.commitAudit(event);
    this.rows.set(`${context.organizationId}:${id}`, row);
    const response = Object.freeze({ status: 201, body: frozenProjection(row, []), etag: etag(row) });
    return this.remember(context, idempotencyKey, fingerprint, response);
  }

  read(context: TenantContext, id: string): StoredMutationResponse<QuestionnaireSessionProjection> {
    const row = this.requireRow(context, id);
    return Object.freeze({ status: 200, body: frozenProjection(row, this.findings(context, id)), etag: etag(row) });
  }

  saveAnswers(
    context: TenantContext,
    id: string,
    input: { readonly stageId: StageId; readonly answers: readonly TenantAnswer[] },
    ifMatch: string | null,
    idempotencyKey: string,
    fingerprint: string,
    nowEpoch: number,
  ): StoredMutationResponse<QuestionnaireSessionProjection> {
    const replay = this.replay(context, idempotencyKey, fingerprint);
    if (replay) return replay;
    const current = this.requireRow(context, id);
    this.requireEtag(current, ifMatch);
    if (current.state === "SUPERSEDED") throw new ControlError("QUESTIONNAIRE_SESSION_TERMINAL", 409);
    const pack = this.packs.require(current.packId, current.packVersion);
    const definitions = questionMap(pack);
    if (!STAGE_IDS.has(input.stageId) || !Array.isArray(input.answers) || input.answers.length > 256) {
      throw new ControlError("QUESTIONNAIRE_ANSWER_SET_REFUSED", 422);
    }
    const supplied = new Set<string>();
    const accepted = input.answers.map((answer): TenantAnswer => {
      if (
        answer === null || typeof answer !== "object" || answer.source !== "TENANT_DECLARATION" ||
        Object.keys(answer).length !== 3 || !["questionId", "value", "source"].every((key) => key in answer) ||
        typeof answer.questionId !== "string" || supplied.has(answer.questionId)
      ) {
        throw new ControlError("QUESTIONNAIRE_ANSWER_SET_REFUSED", 422);
      }
      supplied.add(answer.questionId);
      const definition = definitions.get(answer.questionId);
      if (!definition || definition.stageId !== input.stageId) throw new ControlError("QUESTIONNAIRE_QUESTION_REFUSED", 422);
      return Object.freeze({
        questionId: answer.questionId,
        value: validatedAnswer(definition.question, answer.value),
        source: "TENANT_DECLARATION",
      });
    });
    const answers = new Map(current.answers);
    for (const answer of accepted) answers.set(answer.questionId, answer);
    const completed = JOURNEY_STAGES.filter((stage) => {
      const definitionsForStage = pack.stages.find((candidate) => candidate.id === stage.id)?.questions ?? [];
      return definitionsForStage.every((question) => !question.required || !missing(answers.get(question.id)?.value));
    }).map((stage) => stage.id);
    const firstIncomplete = JOURNEY_STAGES.find((stage) => !completed.includes(stage.id))?.id ?? JOURNEY_STAGES.at(-1)!.id;
    const now = timestamp(nowEpoch);
    const next: SessionRow = Object.freeze({
      ...current,
      state: "IN_PROGRESS",
      currentStageId: firstIncomplete,
      completedStageIds: Object.freeze(completed),
      revision: current.revision + 1,
      answers,
      updatedAt: now,
    });
    const answerRevision = Object.freeze({
      sessionId: id,
      organizationId: context.organizationId,
      revision: next.revision,
      stageId: input.stageId,
      answers: Object.freeze(accepted),
      actorDigest: context.subjectDigest,
      occurredAt: now,
    });
    const event = Object.freeze({
      eventId: randomUUID(),
      organizationId: context.organizationId,
      actorDigest: context.subjectDigest,
      eventType: "questionnaire.answers.saved.v1",
      aggregateId: id,
      aggregateDigest: sha256(canonicalJson({ id, revision: next.revision, stageId: input.stageId, answers: accepted })),
      occurredAt: now,
    });
    this.commitAudit(event);
    this.rows.set(`${context.organizationId}:${id}`, next);
    this.answerHistory.push(answerRevision);
    const response = Object.freeze({ status: 200, body: frozenProjection(next, this.findings(context, id)), etag: etag(next) });
    return this.remember(context, idempotencyKey, fingerprint, response);
  }

  review(
    context: TenantContext,
    id: string,
    ifMatch: string | null,
    idempotencyKey: string,
    fingerprint: string,
    nowEpoch: number,
  ): StoredMutationResponse<QuestionnaireSessionProjection> {
    const replay = this.replay(context, idempotencyKey, fingerprint);
    if (replay) return replay;
    const current = this.requireRow(context, id);
    this.requireEtag(current, ifMatch);
    if (current.state === "SUPERSEDED") throw new ControlError("QUESTIONNAIRE_SESSION_TERMINAL", 409);
    const pack = this.packs.require(current.packId, current.packVersion);
    const now = timestamp(nowEpoch);
    const revision = current.revision + 1;
    const findings: ReadinessFinding[] = [];
    for (const stage of pack.stages) {
      for (const question of stage.questions) {
        if (question.required && missing(current.answers.get(question.id)?.value)) {
          findings.push(Object.freeze({
            findingId: sha256(canonicalJson({ id, revision, stageId: stage.id, questionId: question.id, reasonCode: "MISSING_REQUIRED_ANSWER" })),
            sessionId: id,
            organizationId: context.organizationId,
            revision,
            stageId: stage.id,
            questionId: question.id,
            severity: "BLOCKING",
            reasonCode: "MISSING_REQUIRED_ANSWER",
            occurredAt: now,
          }));
        }
      }
    }
    if (findings.length === 0) {
      findings.push(Object.freeze({
        findingId: sha256(canonicalJson({ id, revision, reasonCode: "QUESTIONNAIRE_COMPLETE" })),
        sessionId: id,
        organizationId: context.organizationId,
        revision,
        stageId: JOURNEY_STAGES.at(-1)!.id,
        questionId: null,
        severity: "PASS",
        reasonCode: "QUESTIONNAIRE_COMPLETE",
        occurredAt: now,
      }));
    }
    const nextState: QuestionnaireState = findings.some((finding) => finding.severity === "BLOCKING") ? "BLOCKED" : "READY_FOR_COMPILATION";
    const next: SessionRow = Object.freeze({
      ...current,
      state: nextState,
      currentStageId: findings.find((finding) => finding.severity === "BLOCKING")?.stageId ?? JOURNEY_STAGES.at(-1)!.id,
      completedStageIds: nextState === "READY_FOR_COMPILATION" ? Object.freeze(JOURNEY_STAGES.map((stage) => stage.id)) : current.completedStageIds,
      revision,
      updatedAt: now,
    });
    const event = Object.freeze({
      eventId: randomUUID(),
      organizationId: context.organizationId,
      actorDigest: context.subjectDigest,
      eventType: "questionnaire.session.reviewed.v1",
      aggregateId: id,
      aggregateDigest: sha256(canonicalJson({ id, revision, state: nextState, findings })),
      occurredAt: now,
    });
    this.commitAudit(event);
    this.rows.set(`${context.organizationId}:${id}`, next);
    this.findingHistory.push(...findings);
    const response = Object.freeze({ status: 200, body: frozenProjection(next, this.findings(context, id)), etag: etag(next) });
    return this.remember(context, idempotencyKey, fingerprint, response);
  }

  answerRevisions(context: TenantContext, id: string): readonly AnswerRevision[] {
    this.requireRow(context, id);
    return Object.freeze(this.answerHistory.filter((revision) => revision.organizationId === context.organizationId && revision.sessionId === id));
  }

  auditEvents(context: TenantContext, id: string): readonly AuditEvent[] {
    this.requireRow(context, id);
    return Object.freeze(this.audit.filter((event) => event.organizationId === context.organizationId && event.aggregateId === id));
  }
}

const STAGE_IDS = new Set<string>(JOURNEY_STAGES.map((stage) => stage.id));
