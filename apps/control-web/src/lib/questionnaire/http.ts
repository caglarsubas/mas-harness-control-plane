import { randomUUID } from "node:crypto";

import { parseJsonNoDuplicates } from "../foundation/canonical";
import { boundedError, ControlError } from "../foundation/contracts";
import { rejectCallerIdentity } from "../foundation/session";
import { JOURNEY_STAGES, QUESTIONNAIRE_SCHEMA, type StageId, type TenantAnswer } from "./contracts";
import type { QuestionnaireRuntime } from "./runtime";
import { mutationFingerprint } from "./session";

const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
});

function response(status: number, body: unknown, etag?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...(etag ? { etag } : {}) },
  });
}

function failure(error: unknown): Response {
  const refused = error instanceof ControlError ? error : new ControlError("QUESTIONNAIRE_INTERNAL_REFUSED", 500);
  return response(refused.status, boundedError(refused.code, randomUUID()));
}

function requestFacts(request: Request): { headers: Record<string, string>; query: Record<string, string> } {
  const headers = Object.fromEntries(request.headers.entries());
  const url = new URL(request.url);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (key in query) throw new ControlError("QUERY_DUPLICATE_REFUSED", 400);
    query[key] = value;
  }
  return { headers, query };
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 65_536) throw new ControlError("REQUEST_BODY_TOO_LARGE", 413);
  let value: unknown;
  try {
    value = parseJsonNoDuplicates(text, 65_536);
  } catch {
    throw new ControlError("REQUEST_BODY_REFUSED", 400);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ControlError("REQUEST_BODY_REFUSED", 400);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !expected.has(key))) {
    throw new ControlError("REQUEST_BODY_REFUSED", 400);
  }
}

function identityCheck(request: Request, parsedBody?: Record<string, unknown>): void {
  const facts = requestFacts(request);
  rejectCallerIdentity({ headers: facts.headers, query: facts.query, body: parsedBody });
}

function idempotency(request: Request): string {
  return request.headers.get("idempotency-key") ?? "";
}

export async function listQuestionnaires(request: Request, runtime: QuestionnaireRuntime): Promise<Response> {
  try {
    identityCheck(request);
    runtime.authenticator.authenticate(request, false, runtime.nowEpoch());
    const items = runtime.packs.list().map((pack) => ({
      schemaVersion: QUESTIONNAIRE_SCHEMA,
      packId: pack.packId,
      packVersion: pack.packVersion,
      title: pack.title,
      industry: pack.industry,
      releaseDigest: pack.releaseDigest,
      stages: pack.stages.map((stage) => ({
        id: stage.id,
        title: stage.title,
        purpose: stage.purpose,
        questionCount: stage.questions.length,
        questions: stage.questions,
      })),
    }));
    return response(200, { schemaVersion: QUESTIONNAIRE_SCHEMA, items });
  } catch (error) {
    return failure(error);
  }
}

export async function createQuestionnaireSession(request: Request, runtime: QuestionnaireRuntime): Promise<Response> {
  try {
    const input = await body(request);
    exact(input, ["packId", "packVersion"]);
    identityCheck(request, input);
    const context = runtime.authenticator.authenticate(request, true, runtime.nowEpoch());
    if (typeof input.packId !== "string" || typeof input.packVersion !== "string") throw new ControlError("REQUEST_BODY_REFUSED", 400);
    const path = "/api/v1alpha1/sessions";
    const result = runtime.sessions.create(
      context,
      { packId: input.packId, packVersion: input.packVersion },
      idempotency(request),
      mutationFingerprint("POST", path, input),
      runtime.nowEpoch(),
    );
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}

export async function getQuestionnaireSession(request: Request, runtime: QuestionnaireRuntime, sessionId: string): Promise<Response> {
  try {
    identityCheck(request);
    const context = runtime.authenticator.authenticate(request, false, runtime.nowEpoch());
    const result = runtime.sessions.read(context, sessionId);
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}

export async function saveQuestionnaireAnswers(
  request: Request,
  runtime: QuestionnaireRuntime,
  sessionId: string,
): Promise<Response> {
  try {
    const input = await body(request);
    exact(input, ["stageId", "answers"]);
    identityCheck(request, input);
    const context = runtime.authenticator.authenticate(request, true, runtime.nowEpoch());
    if (typeof input.stageId !== "string" || !JOURNEY_STAGES.some((stage) => stage.id === input.stageId) || !Array.isArray(input.answers)) {
      throw new ControlError("REQUEST_BODY_REFUSED", 400);
    }
    const answers = input.answers.map((value): TenantAnswer => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ControlError("REQUEST_BODY_REFUSED", 400);
      const item = value as Record<string, unknown>;
      exact(item, ["questionId", "value", "source"]);
      if (typeof item.questionId !== "string" || item.source !== "TENANT_DECLARATION") throw new ControlError("REQUEST_BODY_REFUSED", 400);
      return { questionId: item.questionId, value: item.value as TenantAnswer["value"], source: "TENANT_DECLARATION" };
    });
    const path = `/api/v1alpha1/sessions/${sessionId}/answers`;
    const result = runtime.sessions.saveAnswers(
      context,
      sessionId,
      { stageId: input.stageId as StageId, answers },
      request.headers.get("if-match"),
      idempotency(request),
      mutationFingerprint("PUT", path, input),
      runtime.nowEpoch(),
    );
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}

export async function reviewQuestionnaireSession(
  request: Request,
  runtime: QuestionnaireRuntime,
  sessionId: string,
): Promise<Response> {
  try {
    const input = await body(request);
    exact(input, []);
    identityCheck(request, input);
    const context = runtime.authenticator.authenticate(request, true, runtime.nowEpoch());
    const path = `/api/v1alpha1/sessions/${sessionId}/review`;
    const result = runtime.sessions.review(
      context,
      sessionId,
      request.headers.get("if-match"),
      idempotency(request),
      mutationFingerprint("POST", path, input),
      runtime.nowEpoch(),
    );
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}
