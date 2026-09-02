import { QuestionnaireJourney } from "./QuestionnaireJourney";

export default async function QuestionnaireStagePage({
  params,
}: {
  readonly params: Promise<{ readonly sessionId: string; readonly stageId: string }>;
}) {
  const { sessionId, stageId } = await params;
  return <QuestionnaireJourney sessionId={sessionId} stageId={stageId} />;
}
