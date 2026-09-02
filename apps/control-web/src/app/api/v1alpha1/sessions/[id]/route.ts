import { getQuestionnaireSession } from "../../../../../lib/questionnaire/http";
import { routeQuestionnaireRuntime } from "../../../../../lib/questionnaire/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return getQuestionnaireSession(request, routeQuestionnaireRuntime, id);
}
