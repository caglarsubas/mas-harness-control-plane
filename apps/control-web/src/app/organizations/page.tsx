import { OperatorPortfolio } from "../../components/harness-overview/OperatorPortfolio";
import { createFixtureProjectionSet } from "../../lib/harness-status/fixtures";

export default function OrganizationsPage() {
  const primary = createFixtureProjectionSet();
  const secondary = createFixtureProjectionSet("org.copper-ridge-labs", "Copper Ridge Materials Lab");
  return <OperatorPortfolio organizations={[primary.overview, secondary.overview]} />;
}

