import { getApproval } from "../../../../../lib/demands/http";
import { routeDemandRuntime } from "../../../../../lib/demands/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return getApproval(request, routeDemandRuntime, id);
}

