import type { TenantContext } from "../foundation/contracts";
import { routeQuestionnaireRuntime, type RequestAuthenticator } from "../questionnaire/runtime";
import { createFixtureProjectionSet, FIXTURE_NOW_EPOCH, sourceSummary } from "./fixtures";
import { DenyOperatorPolicy, ProjectionStore, type OperatorPolicy, type SourceAdmissionPolicy } from "./projection-store";

export type TenantStatusAction = "harness:overview:view" | "harness:detail:view";

export interface TenantStatusPolicy {
  authorize(context: TenantContext, action: TenantStatusAction): boolean;
}

export class DenyTenantStatusPolicy implements TenantStatusPolicy {
  authorize(): boolean {
    return false;
  }
}

export interface HarnessStatusRuntime {
  readonly store: ProjectionStore;
  readonly authenticator: RequestAuthenticator;
  readonly tenantPolicy: TenantStatusPolicy;
  readonly operatorPolicy: OperatorPolicy;
  readonly nowEpoch: () => number;
}

class FixtureSourceAdmission implements SourceAdmissionPolicy {
  authorize(summary: { readonly sourcePrincipalDigest: string; readonly sourceAdmissionDigest: string }): boolean {
    return summary.sourcePrincipalDigest === `sha256:${"4".repeat(64)}` && summary.sourceAdmissionDigest === `sha256:${"5".repeat(64)}`;
  }
}

const routeStore = new ProjectionStore(new FixtureSourceAdmission());
routeStore.ingest(sourceSummary("PROFILE_LOCK", 1, createFixtureProjectionSet()), FIXTURE_NOW_EPOCH);

export const routeHarnessStatusRuntime: HarnessStatusRuntime = Object.freeze({
  store: routeStore,
  authenticator: routeQuestionnaireRuntime.authenticator,
  tenantPolicy: new DenyTenantStatusPolicy(),
  operatorPolicy: new DenyOperatorPolicy(),
  nowEpoch: () => Math.floor(Date.now() / 1000),
});
