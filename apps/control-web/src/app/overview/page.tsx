import { OverviewPage, parseFilters } from "../../components/harness-overview/OverviewPage";
import { createFixtureProjectionSet } from "../../lib/harness-status/fixtures";

export default async function TenantOverviewPage({ searchParams }: { readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> }) {
  const query = await searchParams;
  const projections = createFixtureProjectionSet();
  return <OverviewPage overview={projections.overview} harnesses={projections.harnesses} filters={parseFilters(query)} />;
}
