import { randomUUID } from "node:crypto";

import { parseJsonNoDuplicates } from "../foundation/canonical";
import { boundedError, ControlError } from "../foundation/contracts";
import { rejectCallerIdentity } from "../foundation/session";
import { assertBrowserMutation, secureJsonResponse } from "../security/http";
import type { DemandCreateInput } from "./contracts";
import type { DemandRuntime } from "./runtime";
import { mutationFingerprint } from "./service";

function response(status: number, body: unknown, etag?: string): Response {
  return secureJsonResponse(status, body, etag);
}

function failure(error: unknown): Response {
  const refused = error instanceof ControlError ? error : new ControlError("DEMAND_INTERNAL_REFUSED", 500);
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

async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 131_072) throw new ControlError("REQUEST_BODY_TOO_LARGE", 413);
  let value: unknown;
  try {
    value = parseJsonNoDuplicates(text, 131_072);
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

export async function createDemand(request: Request, runtime: DemandRuntime): Promise<Response> {
  try {
    assertBrowserMutation(request);
    const input = await body(request);
    exact(input, [
      "source",
      "requestedCapabilities",
      "proposedPrerequisiteHarnessIds",
      "prerequisiteDecisions",
      "environment",
      "assuranceSubjects",
      "executionBudget",
    ]);
    identityCheck(request, input);
    const context = runtime.authenticator.authenticate(request, true, runtime.nowEpoch());
    const path = "/api/v1alpha1/demands";
    const result = runtime.store.create(
      context,
      input as unknown as DemandCreateInput,
      idempotency(request),
      mutationFingerprint("POST", path, input),
      runtime.nowEpoch(),
    );
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}

export async function getDemand(request: Request, runtime: DemandRuntime, demandId: string): Promise<Response> {
  try {
    identityCheck(request);
    const context = runtime.authenticator.authenticate(request, false, runtime.nowEpoch());
    const result = runtime.store.readDemand(context, demandId);
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}

export async function validateDemand(request: Request, runtime: DemandRuntime, demandId: string): Promise<Response> {
  try {
    assertBrowserMutation(request);
    const input = await body(request);
    exact(input, []);
    identityCheck(request, input);
    const context = runtime.authenticator.authenticate(request, true, runtime.nowEpoch());
    const path = `/api/v1alpha1/demands/${demandId}/validate`;
    const result = runtime.store.validate(
      context,
      demandId,
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

export async function requestDemandApproval(request: Request, runtime: DemandRuntime, demandId: string): Promise<Response> {
  try {
    assertBrowserMutation(request);
    const input = await body(request);
    exact(input, []);
    identityCheck(request, input);
    const context = runtime.authenticator.authenticate(request, true, runtime.nowEpoch());
    const path = `/api/v1alpha1/demands/${demandId}/approve`;
    const result = runtime.store.requestApproval(
      context,
      demandId,
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

export async function getApproval(request: Request, runtime: DemandRuntime, approvalId: string): Promise<Response> {
  try {
    identityCheck(request);
    const context = runtime.authenticator.authenticate(request, false, runtime.nowEpoch());
    const result = runtime.store.readApproval(context, approvalId);
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}

export async function recordApprovalDecision(request: Request, runtime: DemandRuntime, approvalId: string): Promise<Response> {
  try {
    assertBrowserMutation(request);
    const input = await body(request);
    exact(input, ["decision", "reasonCode"]);
    identityCheck(request, input);
    if (
      (input.decision !== "APPROVE" && input.decision !== "REJECT") ||
      typeof input.reasonCode !== "string"
    ) {
      throw new ControlError("REQUEST_BODY_REFUSED", 400);
    }
    const context = runtime.authenticator.authenticate(request, true, runtime.nowEpoch());
    const path = `/api/v1alpha1/approvals/${approvalId}/decision`;
    const decision = { decision: input.decision, reasonCode: input.reasonCode } as const;
    const result = runtime.store.decide(
      context,
      approvalId,
      decision,
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
