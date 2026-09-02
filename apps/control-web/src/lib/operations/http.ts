import { randomUUID } from "node:crypto";

import { parseJsonNoDuplicates } from "../foundation/canonical";
import { boundedError, ControlError } from "../foundation/contracts";
import { rejectCallerIdentity } from "../foundation/session";
import type { OperationRuntime } from "./runtime";
import { operationMutationFingerprint } from "./service";

const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
});

function response(status: number, body: unknown, etag?: string): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...(etag ? { etag } : {}) } });
}

function failure(error: unknown): Response {
  const refused = error instanceof ControlError ? error : new ControlError("OPERATION_INTERNAL_REFUSED", 500);
  return response(refused.status, boundedError(refused.code, randomUUID()));
}

function requestFacts(request: Request): { headers: Record<string, string>; query: Record<string, string> } {
  const headers = Object.fromEntries(request.headers.entries());
  const query: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams.entries()) {
    if (key in query) throw new ControlError("QUERY_DUPLICATE_REFUSED", 400);
    query[key] = value;
  }
  return { headers, query };
}

async function emptyBody(request: Request): Promise<Record<string, never>> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 4096) throw new ControlError("REQUEST_BODY_TOO_LARGE", 413);
  let value: unknown;
  try {
    value = parseJsonNoDuplicates(text, 4096);
  } catch {
    throw new ControlError("REQUEST_BODY_REFUSED", 400);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw new ControlError("REQUEST_BODY_REFUSED", 400);
  }
  return value as Record<string, never>;
}

function identityCheck(request: Request, body?: Record<string, unknown>): void {
  const facts = requestFacts(request);
  rejectCallerIdentity({ headers: facts.headers, query: facts.query, body });
}

export async function requestProfileCompilation(request: Request, runtime: OperationRuntime, demandId: string): Promise<Response> {
  try {
    const input = await emptyBody(request);
    identityCheck(request, input);
    const context = runtime.authenticator.authenticate(request, true, runtime.nowEpoch());
    const path = `/api/v1alpha1/demands/${demandId}/compile`;
    const result = runtime.store.requestCompilation(
      context,
      demandId,
      request.headers.get("if-match"),
      request.headers.get("idempotency-key") ?? "",
      operationMutationFingerprint("POST", path, input),
      runtime.nowEpoch(),
    );
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}

export async function getOperation(request: Request, runtime: OperationRuntime, operationId: string): Promise<Response> {
  try {
    identityCheck(request);
    const context = runtime.authenticator.authenticate(request, false, runtime.nowEpoch());
    const result = runtime.store.readOperation(context, operationId);
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}
