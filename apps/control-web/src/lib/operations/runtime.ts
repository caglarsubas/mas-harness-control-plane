import { routeDemandRuntime } from "../demands/runtime";
import type { RequestAuthenticator } from "../questionnaire/runtime";
import { UnavailableCompileInputResolver } from "./dependencies";
import { OperationStore } from "./service";

export interface OperationRuntime {
  readonly store: OperationStore;
  readonly authenticator: RequestAuthenticator;
  readonly nowEpoch: () => number;
}

export const routeOperationRuntime: OperationRuntime = Object.freeze({
  store: new OperationStore(routeDemandRuntime.store, new UnavailableCompileInputResolver()),
  authenticator: routeDemandRuntime.authenticator,
  nowEpoch: routeDemandRuntime.nowEpoch,
});
