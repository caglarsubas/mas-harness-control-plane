import { Suspense } from "react";

import { OperatorPortfolio } from "../../components/harness-overview/OperatorPortfolio";
import { StatusLoading } from "../../components/harness-overview/StatusBoundary";
import { createFixtureProjectionSet } from "../../lib/harness-status/fixtures";

export default function OrganizationsPage() {
  const primary = createFixtureProjectionSet();
  const secondary = createFixtureProjectionSet("org.copper-ridge-labs", "Copper Ridge Materials Lab");
  return <Suspense fallback={<StatusLoading label="Loading the authorized organization portfolio" />}><OperatorPortfolio organizations={[primary.overview, secondary.overview]} /></Suspense>;
}
