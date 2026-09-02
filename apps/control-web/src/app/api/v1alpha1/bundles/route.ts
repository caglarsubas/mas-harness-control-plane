import { requestBundle } from "../../../../lib/profiles/http";
import { routeProfileRuntime } from "../../../../lib/profiles/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return requestBundle(request, routeProfileRuntime);
}
