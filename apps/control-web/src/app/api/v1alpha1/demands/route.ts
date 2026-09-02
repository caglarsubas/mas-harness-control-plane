import { createDemand } from "../../../../lib/demands/http";
import { routeDemandRuntime } from "../../../../lib/demands/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return createDemand(request, routeDemandRuntime);
}

