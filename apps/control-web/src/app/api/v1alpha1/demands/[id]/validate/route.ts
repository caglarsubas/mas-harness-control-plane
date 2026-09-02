import { validateDemand } from "../../../../../../lib/demands/http";
import { routeDemandRuntime } from "../../../../../../lib/demands/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return validateDemand(request, routeDemandRuntime, id);
}

