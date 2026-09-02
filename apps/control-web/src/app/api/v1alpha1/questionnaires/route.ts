import { listQuestionnaires } from "../../../../lib/questionnaire/http";
import { routeQuestionnaireRuntime } from "../../../../lib/questionnaire/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return listQuestionnaires(request, routeQuestionnaireRuntime);
}
