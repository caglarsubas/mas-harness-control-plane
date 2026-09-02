import { getBundle } from "../../../../../lib/profiles/http";
import { routeProfileRuntime } from "../../../../../lib/profiles/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return getBundle(request, routeProfileRuntime, id);
}
