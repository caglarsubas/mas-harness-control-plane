import { routeOperationRuntime } from "../operations/runtime";
import type { RequestAuthenticator } from "../questionnaire/runtime";
import { UnavailableProfileApprovalPolicy } from "./dependencies";
import { ProfileLifecycleStore } from "./service";

export interface ProfileRuntime {
  readonly store: ProfileLifecycleStore;
  readonly authenticator: RequestAuthenticator;
  readonly nowEpoch: () => number;
}

export const routeProfileRuntime: ProfileRuntime = Object.freeze({
  store: new ProfileLifecycleStore(new UnavailableProfileApprovalPolicy(), routeOperationRuntime.store),
  authenticator: routeOperationRuntime.authenticator,
  nowEpoch: routeOperationRuntime.nowEpoch,
});
