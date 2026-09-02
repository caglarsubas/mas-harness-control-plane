import type { TenantContext } from "../foundation/contracts";
import { ControlError } from "../foundation/contracts";
import { InMemorySessionStore } from "../foundation/session";
import { AdmittedIndustryPackRegistry } from "./pack";
import { QuestionnaireSessionStore } from "./session";

export interface RequestAuthenticator {
  authenticate(request: Request, mutation: boolean, nowEpoch: number): TenantContext;
}

export interface QuestionnaireRuntime {
  readonly packs: AdmittedIndustryPackRegistry;
  readonly sessions: QuestionnaireSessionStore;
  readonly authenticator: RequestAuthenticator;
  readonly nowEpoch: () => number;
}

function cookieValue(request: Request): string {
  const raw = request.headers.get("cookie") ?? "";
  if (raw.length > 8_192) throw new ControlError("SESSION_REFUSED", 401);
  const matches = raw.split(";").map((item) => item.trim()).filter((item) => item.startsWith("__Host-planeon_session="));
  if (matches.length !== 1) throw new ControlError("SESSION_REFUSED", 401);
  const value = matches[0].slice("__Host-planeon_session=".length);
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(value)) throw new ControlError("SESSION_REFUSED", 401);
  return value;
}

export class OpaqueSessionAuthenticator implements RequestAuthenticator {
  constructor(private readonly store: InMemorySessionStore) {}

  authenticate(request: Request, mutation: boolean, nowEpoch: number): TenantContext {
    const csrf = request.headers.get("x-csrf-token");
    if (csrf && !/^[A-Za-z0-9_-]{32,256}$/u.test(csrf)) throw new ControlError("CSRF_REFUSED", 403);
    return this.store.authenticate(cookieValue(request), csrf, mutation, nowEpoch);
  }
}

const authenticationStore = new InMemorySessionStore();
const packRegistry = new AdmittedIndustryPackRegistry();
const sessionStore = new QuestionnaireSessionStore(packRegistry);

export const routeQuestionnaireRuntime: QuestionnaireRuntime = Object.freeze({
  packs: packRegistry,
  sessions: sessionStore,
  authenticator: new OpaqueSessionAuthenticator(authenticationStore),
  nowEpoch: () => Math.floor(Date.now() / 1000),
});

export function controlAuthenticationStore(): InMemorySessionStore {
  return authenticationStore;
}
