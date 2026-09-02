import { readiness } from "../../../lib/foundation/health";
import type { DependencyStatus } from "../../../lib/foundation/contracts";

export const dynamic = "force-dynamic";

export function readinessResponse(dependencies: readonly DependencyStatus[]): Response {
  const health = readiness(dependencies);
  return Response.json(health, {
    status: health.state === "READY" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}

export function GET(): Response {
  return readinessResponse([]);
}
