import { controlAuthenticationStore, OpaqueSessionAuthenticator, type RequestAuthenticator } from "../questionnaire/runtime";
import { FixedApprovalPolicyHook, InMemoryDemandSourceResolver } from "./dependencies";
import { DemandApprovalStore } from "./service";

export interface DemandRuntime {
  readonly store: DemandApprovalStore;
  readonly authenticator: RequestAuthenticator;
  readonly nowEpoch: () => number;
}

const sourceResolver = new InMemoryDemandSourceResolver();
const policyHook = new FixedApprovalPolicyHook();

export const routeDemandRuntime: DemandRuntime = Object.freeze({
  store: new DemandApprovalStore(sourceResolver, policyHook),
  authenticator: new OpaqueSessionAuthenticator(controlAuthenticationStore()),
  nowEpoch: () => Math.floor(Date.now() / 1000),
});

