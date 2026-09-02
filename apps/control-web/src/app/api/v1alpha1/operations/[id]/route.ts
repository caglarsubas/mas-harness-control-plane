import { getOperation } from "../../../../../lib/operations/http";
import { routeOperationRuntime } from "../../../../../lib/operations/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return getOperation(request, routeOperationRuntime, id);
}
