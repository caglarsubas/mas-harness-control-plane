export const FOUNDATION_SCHEMA = "planeon.control.foundation/v1" as const;

export type DependencyState = "READY" | "DEGRADED" | "NOT_READY";
export type SessionState = "ACTIVE" | "REVOKED" | "EXPIRED";

export interface ControlErrorBody {
  readonly schemaVersion: typeof FOUNDATION_SCHEMA;
  readonly code: string;
  readonly correlationId: string;
  readonly message: string;
}

export interface TenantContext {
  readonly schemaVersion: typeof FOUNDATION_SCHEMA;
  readonly organizationId: string;
  readonly subjectDigest: string;
  readonly sessionId: string;
  readonly admissionDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface AdmittedPrincipal {
  readonly organizationId: string;
  readonly subjectDigest: string;
  readonly admissionDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly tokenIdDigest: string;
}

export interface DependencyStatus {
  readonly name: string;
  readonly required: boolean;
  readonly state: DependencyState;
  readonly reasonCode: string;
  readonly observedAt: string;
}

export interface ServiceHealth {
  readonly schemaVersion: typeof FOUNDATION_SCHEMA;
  readonly service: "control-web" | "profile-compiler-worker";
  readonly state: "RUNNING" | "READY" | "NOT_READY";
  readonly dependencies: readonly DependencyStatus[];
}

export class ControlError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
    this.name = "ControlError";
  }
}

export function boundedError(code: string, correlationId: string): ControlErrorBody {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(code)) throw new ControlError("ERROR_CODE_INVALID", 500);
  if (!/^[a-zA-Z0-9-]{8,64}$/u.test(correlationId)) throw new ControlError("CORRELATION_ID_INVALID", 500);
  return {
    schemaVersion: FOUNDATION_SCHEMA,
    code,
    correlationId,
    message: "Request refused.",
  };
}
