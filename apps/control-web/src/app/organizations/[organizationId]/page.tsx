import { notFound } from "next/navigation";

import { OverviewPage, parseFilters } from "../../../components/harness-overview/OverviewPage";
import { createFixtureProjectionSet, FIXTURE_ORGANIZATION_ID } from "../../../lib/harness-status/fixtures";

export default async function OrganizationOverviewPage({ params, searchParams }: { readonly params: Promise<{ readonly organizationId: string }>; readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> }) {
  const [{ organizationId }, query] = await Promise.all([params, searchParams]);
  const known = organizationId === FIXTURE_ORGANIZATION_ID
    ? createFixtureProjectionSet()
    : organizationId === "org.copper-ridge-labs" ? createFixtureProjectionSet(organizationId, "Copper Ridge Materials Lab") : null;
  if (!known) notFound();
  return <OverviewPage overview={known.overview} harnesses={known.harnesses} filters={parseFilters(query)} operatorScope />;
}
