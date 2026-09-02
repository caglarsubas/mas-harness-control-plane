import { getTenantPlane } from "../../../../../lib/harness-status/http";
import { routeHarnessStatusRuntime } from "../../../../../lib/harness-status/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { readonly params: Promise<{ readonly planeId: string }> }): Promise<Response> {
  const { planeId } = await context.params;
  return getTenantPlane(request, routeHarnessStatusRuntime, planeId);
}

