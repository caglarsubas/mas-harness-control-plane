import { getOrganizationPortfolio } from "../../../../lib/harness-status/http";
import { routeHarnessStatusRuntime } from "../../../../lib/harness-status/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return getOrganizationPortfolio(request, routeHarnessStatusRuntime);
}

