import { notFound } from "next/navigation";
import { Suspense } from "react";

import { OverviewPage, parseFilters } from "../../../components/harness-overview/OverviewPage";
import { StatusLoading } from "../../../components/harness-overview/StatusBoundary";
import { resolveOrganizationProjection } from "../../../lib/harness-status/page-resolution";

export default async function OrganizationOverviewPage({ params, searchParams }: { readonly params: Promise<{ readonly organizationId: string }>; readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> }) {
  const [{ organizationId }, query] = await Promise.all([params, searchParams]);
  const known = resolveOrganizationProjection(organizationId);
  if (!known) notFound();
  return <Suspense fallback={<StatusLoading label="Loading the authorized organization projection" />}><OverviewPage overview={known.overview} harnesses={known.harnesses} filters={parseFilters(query)} operatorScope /></Suspense>;
}
