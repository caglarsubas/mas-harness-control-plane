import { notFound } from "next/navigation";

import { PlaneDetailPage } from "../../../components/harness-overview/DetailPages";
import { createFixtureProjectionSet } from "../../../lib/harness-status/fixtures";
import { planeDefinition } from "../../../lib/harness-status/taxonomy";

export default async function PlanePage({ params }: { readonly params: Promise<{ readonly planeId: string }> }) {
  const { planeId } = await params;
  if (!planeDefinition(planeId)) notFound();
  const projection = createFixtureProjectionSet().planes.find((item) => item.spec.planeId === planeId);
  if (!projection) notFound();
  return <PlaneDetailPage projection={projection} />;
}

