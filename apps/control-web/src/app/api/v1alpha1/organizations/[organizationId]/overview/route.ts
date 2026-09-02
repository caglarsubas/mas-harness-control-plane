import { getOrganizationOverview } from "../../../../../../lib/harness-status/http";
import { routeHarnessStatusRuntime } from "../../../../../../lib/harness-status/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { readonly params: Promise<{ readonly organizationId: string }> }): Promise<Response> {
  const { organizationId } = await context.params;
  return getOrganizationOverview(request, routeHarnessStatusRuntime, organizationId);
}
