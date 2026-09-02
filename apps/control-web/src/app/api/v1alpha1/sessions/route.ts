import { createQuestionnaireSession } from "../../../../lib/questionnaire/http";
import { routeQuestionnaireRuntime } from "../../../../lib/questionnaire/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return createQuestionnaireSession(request, routeQuestionnaireRuntime);
}
