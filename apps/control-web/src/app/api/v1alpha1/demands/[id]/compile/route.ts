import { requestProfileCompilation } from "../../../../../../lib/operations/http";
import { routeOperationRuntime } from "../../../../../../lib/operations/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return requestProfileCompilation(request, routeOperationRuntime, id);
}
