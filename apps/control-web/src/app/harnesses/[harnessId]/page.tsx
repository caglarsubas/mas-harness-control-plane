import { notFound } from "next/navigation";

import { HarnessDetailPage } from "../../../components/harness-overview/DetailPages";
import { createFixtureProjectionSet } from "../../../lib/harness-status/fixtures";
import { harnessDefinition } from "../../../lib/harness-status/taxonomy";

export default async function HarnessPage({ params }: { readonly params: Promise<{ readonly harnessId: string }> }) {
  const { harnessId } = await params;
  if (!harnessDefinition(harnessId)) notFound();
  const projection = createFixtureProjectionSet().harnesses.find((item) => item.spec.harnessId === harnessId);
  if (!projection) notFound();
  return <HarnessDetailPage projection={projection} />;
}
