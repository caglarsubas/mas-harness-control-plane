import { randomUUID } from "node:crypto";

import { boundedError, ControlError, type TenantContext } from "../foundation/contracts";
import { rejectCallerIdentity } from "../foundation/session";
import { API_SECURITY_HEADERS } from "../security/http";
import { AGGREGATE_STATES, type AggregateState, type PlaneId } from "./contracts";
import type { HarnessStatusRuntime, TenantStatusAction } from "./runtime";
import { harnessDefinition, planeDefinition } from "./taxonomy";

const FORBIDDEN_AUTHORITY_HEADERS = new Set(["x-role", "x-user-role", "x-policy", "x-policy-digest", "x-subject-id"]);

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...API_SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" } });
}

function failure(error: unknown): Response {
  const refused = error instanceof ControlError ? error : new ControlError("STATUS_INTERNAL_REFUSED", 500);
  return response(refused.status, boundedError(refused.code, randomUUID()));
}

function requestQuery(request: Request, allowed: readonly string[]): Readonly<Record<string, string>> {
  if (request.method !== "GET") throw new ControlError("STATUS_METHOD_REFUSED", 405);
  if (request.body !== null) throw new ControlError("STATUS_BODY_REFUSED", 400);
  const headers = Object.fromEntries(request.headers.entries());
  if (Object.keys(headers).some((header) => FORBIDDEN_AUTHORITY_HEADERS.has(header.toLowerCase()))) throw new ControlError("CALLER_AUTHORITY_REFUSED", 400);
  const query: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams.entries()) {
    if (!allowed.includes(key) || key in query) throw new ControlError("STATUS_QUERY_REFUSED", 400);
    query[key] = value;
  }
  rejectCallerIdentity({ headers, query });
  return Object.freeze(query);
}

function tenantContext(request: Request, runtime: HarnessStatusRuntime, action: TenantStatusAction): TenantContext {
  requestQuery(request, []);
  const context = runtime.authenticator.authenticate(request, false, runtime.nowEpoch());
  if (!runtime.tenantPolicy.authorize(context, action)) throw new ControlError("STATUS_ACCESS_REFUSED", 403);
  return context;
}

export async function getTenantOverview(request: Request, runtime: HarnessStatusRuntime): Promise<Response> {
  try {
    return response(200, runtime.store.readOverview(tenantContext(request, runtime, "harness:overview:view")));
  } catch (error) {
    return failure(error);
  }
}

export async function getTenantPlane(request: Request, runtime: HarnessStatusRuntime, planeId: string): Promise<Response> {
  try {
    const context = tenantContext(request, runtime, "harness:detail:view");
    if (!planeDefinition(planeId)) throw new ControlError("STATUS_PROJECTION_NOT_FOUND", 404);
    return response(200, runtime.store.readPlane(context, planeId as PlaneId));
  } catch (error) {
    return failure(error);
  }
}

export async function getTenantHarness(request: Request, runtime: HarnessStatusRuntime, harnessId: string): Promise<Response> {
  try {
    const context = tenantContext(request, runtime, "harness:detail:view");
    if (!harnessDefinition(harnessId)) throw new ControlError("STATUS_PROJECTION_NOT_FOUND", 404);
    return response(200, runtime.store.readHarness(context, harnessId));
  } catch (error) {
    return failure(error);
  }
}

function operatorDecision(
  runtime: HarnessStatusRuntime,
  context: TenantContext,
  target: string,
): void {
  const decision = runtime.operatorPolicy.authorize(context.subjectDigest, "organization:portfolio:view", target);
  runtime.store.appendOperatorAudit({
    subjectDigest: context.subjectDigest,
    action: "organization:portfolio:view",
    target,
    decision: decision.allowed ? "ALLOW" : "DENY",
    policyDigest: decision.policyDigest,
    occurredAt: new Date(runtime.nowEpoch() * 1000).toISOString().replace(".000Z", "Z"),
  });
  if (!decision.allowed) throw new ControlError(target === "LIST" ? "STATUS_ACCESS_REFUSED" : "STATUS_PROJECTION_NOT_FOUND", target === "LIST" ? 403 : 404);
}

export async function getOrganizationPortfolio(request: Request, runtime: HarnessStatusRuntime): Promise<Response> {
  try {
    const query = requestQuery(request, ["cursor", "limit", "state"]);
    const context = runtime.authenticator.authenticate(request, false, runtime.nowEpoch());
    operatorDecision(runtime, context, "LIST");
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const state = query.state === undefined ? null : AGGREGATE_STATES.includes(query.state as AggregateState) ? query.state as AggregateState : (() => { throw new ControlError("STATUS_QUERY_REFUSED", 400); })();
    return response(200, runtime.store.portfolio(limit, query.cursor ?? null, state));
  } catch (error) {
    return failure(error);
  }
}

export async function getOrganizationOverview(
  request: Request,
  runtime: HarnessStatusRuntime,
  organizationId: string,
): Promise<Response> {
  try {
    requestQuery(request, []);
    const context = runtime.authenticator.authenticate(request, false, runtime.nowEpoch());
    operatorDecision(runtime, context, organizationId);
    return response(200, runtime.store.readOrganization(organizationId));
  } catch (error) {
    return failure(error);
  }
}
