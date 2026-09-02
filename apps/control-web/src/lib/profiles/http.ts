import { randomUUID } from "node:crypto";

import { parseJsonNoDuplicates } from "../foundation/canonical";
import { boundedError, ControlError } from "../foundation/contracts";
import { rejectCallerIdentity } from "../foundation/session";
import type { ProfileRuntime } from "./runtime";
import { profileMutationFingerprint } from "./service";

const JSON_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
});

function response(status: number, body: unknown, etag?: string, location?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...(etag ? { etag } : {}), ...(location ? { location } : {}) },
  });
}

function failure(error: unknown): Response {
  const refused = error instanceof ControlError ? error : new ControlError("PROFILE_INTERNAL_REFUSED", 500);
  return response(refused.status, boundedError(refused.code, randomUUID()));
}

function requestFacts(request: Request): { readonly headers: Record<string, string>; readonly query: Record<string, string> } {
  const headers = Object.fromEntries(request.headers.entries());
  const query: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams.entries()) {
    if (key in query) throw new ControlError("QUERY_DUPLICATE_REFUSED", 400);
    query[key] = value;
  }
  return { headers, query };
}

function identityCheck(request: Request, body?: Record<string, unknown>): void {
  const facts = requestFacts(request);
  rejectCallerIdentity({ headers: facts.headers, query: facts.query, body });
}

async function body(request: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 4096) throw new ControlError("REQUEST_BODY_TOO_LARGE", 413);
  let parsed: unknown;
  try {
    parsed = parseJsonNoDuplicates(text, 4096);
  } catch {
    throw new ControlError("REQUEST_BODY_REFUSED", 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ControlError("REQUEST_BODY_REFUSED", 400);
  const value = parsed as Record<string, unknown>;
  const expected = new Set(keys);
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !expected.has(key))) {
    throw new ControlError("REQUEST_BODY_REFUSED", 400);
  }
  return value;
}

function idempotency(request: Request): string {
  return request.headers.get("idempotency-key") ?? "";
}

export async function getProfile(request: Request, runtime: ProfileRuntime, profileId: string): Promise<Response> {
  try {
    identityCheck(request);
    const context = runtime.authenticator.authenticate(request, false, runtime.nowEpoch());
    const result = runtime.store.readProfile(context, profileId);
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}

export async function getProfileExplanation(request: Request, runtime: ProfileRuntime, profileId: string): Promise<Response> {
  try {
    identityCheck(request);
    const context = runtime.authenticator.authenticate(request, false, runtime.nowEpoch());
    const explanation = runtime.store.explanation(context, profileId);
    return new Response(Buffer.from(explanation), {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/markdown; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return failure(error);
  }
}

export async function requestProfileApproval(request: Request, runtime: ProfileRuntime, profileId: string): Promise<Response> {
  try {
    const input = await body(request, []);
    identityCheck(request, input);
    const context = runtime.authenticator.authenticate(request, true, runtime.nowEpoch());
    const path = `/api/v1alpha1/profiles/${profileId}/approve`;
    const result = runtime.store.requestApproval(
      context, profileId, request.headers.get("if-match"), idempotency(request),
      profileMutationFingerprint("POST", path, input), runtime.nowEpoch(),
    );
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}

export async function getProfileApproval(request: Request, runtime: ProfileRuntime, profileId: string): Promise<Response> {
  try {
    identityCheck(request);
    const context = runtime.authenticator.authenticate(request, false, runtime.nowEpoch());
    const result = runtime.store.readApproval(context, profileId);
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}

export async function recordProfileApprovalDecision(request: Request, runtime: ProfileRuntime, profileId: string): Promise<Response> {
  try {
    const input = await body(request, ["decision", "reasonCode"]);
    identityCheck(request, input);
    if ((input.decision !== "APPROVE" && input.decision !== "REJECT") || typeof input.reasonCode !== "string") {
      throw new ControlError("REQUEST_BODY_REFUSED", 400);
    }
    const context = runtime.authenticator.authenticate(request, true, runtime.nowEpoch());
    const path = `/api/v1alpha1/profiles/${profileId}/approval/decision`;
    const result = runtime.store.decide(
      context, profileId, { decision: input.decision, reasonCode: input.reasonCode },
      request.headers.get("if-match"), idempotency(request), profileMutationFingerprint("POST", path, input), runtime.nowEpoch(),
    );
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}

export async function lockProfile(request: Request, runtime: ProfileRuntime, profileId: string): Promise<Response> {
  try {
    const input = await body(request, []);
    identityCheck(request, input);
    const context = runtime.authenticator.authenticate(request, true, runtime.nowEpoch());
    const path = `/api/v1alpha1/profiles/${profileId}/lock`;
    const result = runtime.store.lock(
      context, profileId, request.headers.get("if-match"), idempotency(request),
      profileMutationFingerprint("POST", path, input), runtime.nowEpoch(),
    );
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}

export async function requestBundle(request: Request, runtime: ProfileRuntime): Promise<Response> {
  try {
    const input = await body(request, ["profileId"]);
    identityCheck(request, input);
    if (typeof input.profileId !== "string") throw new ControlError("REQUEST_BODY_REFUSED", 400);
    const context = runtime.authenticator.authenticate(request, true, runtime.nowEpoch());
    const path = "/api/v1alpha1/bundles";
    const result = runtime.store.requestBundle(
      context, input.profileId, request.headers.get("if-match"), idempotency(request),
      profileMutationFingerprint("POST", path, input), runtime.nowEpoch(),
    );
    return response(result.status, result.body, result.etag, `/api/v1alpha1/bundles/${result.body.id}`);
  } catch (error) {
    return failure(error);
  }
}

export async function getBundle(request: Request, runtime: ProfileRuntime, bundleId: string): Promise<Response> {
  try {
    identityCheck(request);
    const context = runtime.authenticator.authenticate(request, false, runtime.nowEpoch());
    const result = runtime.store.readBundle(context, bundleId);
    return response(result.status, result.body, result.etag);
  } catch (error) {
    return failure(error);
  }
}
