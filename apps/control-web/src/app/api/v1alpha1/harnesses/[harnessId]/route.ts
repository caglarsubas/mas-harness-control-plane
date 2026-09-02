import { getTenantHarness } from "../../../../../lib/harness-status/http";
import { routeHarnessStatusRuntime } from "../../../../../lib/harness-status/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { readonly params: Promise<{ readonly harnessId: string }> }): Promise<Response> {
  const { harnessId } = await context.params;
  return getTenantHarness(request, routeHarnessStatusRuntime, harnessId);
}

