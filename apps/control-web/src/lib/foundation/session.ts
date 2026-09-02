import { randomBytes, timingSafeEqual } from "node:crypto";

import { canonicalJson, sha256 } from "./canonical";
import {
  ControlError,
  FOUNDATION_SCHEMA,
  type SessionState,
  type TenantContext,
} from "./contracts";
import {
  admitIdToken,
  MemoryReplayStore,
  type OidcIssuerRegistry,
} from "./oidc";

const ATTEMPT_SECONDS = 600;
const ABSOLUTE_SECONDS = 28_800;
const IDLE_SECONDS = 1_800;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FORBIDDEN_IDENTITY = new Set([
  "organizationid",
  "tenantid",
  "subjectid",
  "sessionid",
  "x-organization-id",
  "x-tenant-id",
]);

export interface AuthorizationAttemptView {
  readonly attemptId: string;
  readonly state: string;
  readonly nonce: string;
  readonly pkceVerifier: string;
  readonly expiresAt: string;
}

interface AuthorizationAttemptRecord {
  readonly attemptId: string;
  readonly stateDigest: string;
  readonly nonceDigest: string;
  readonly pkceVerifierDigest: string;
  readonly createdAtEpoch: number;
  readonly expiresAtEpoch: number;
  readonly consumedAtEpoch: number | null;
}

interface SessionRecord {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly subjectDigest: string;
  readonly admissionDigest: string;
  readonly cookieDigest: string;
  readonly csrfDigest: string;
  readonly issuedAtEpoch: number;
  readonly absoluteExpiresAtEpoch: number;
  readonly idleExpiresAtEpoch: number;
  readonly version: number;
  readonly state: SessionState;
}

interface AuditRecord {
  readonly eventId: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly subjectDigest: string;
  readonly aggregateDigest: string;
  readonly occurredAt: string;
}

interface SessionRevisionRecord {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly revision: number;
  readonly state: SessionState;
  readonly occurredAt: string;
}

export interface SessionStart {
  readonly context: TenantContext;
  readonly cookie: string;
  readonly csrfToken: string;
}

export class InMemorySessionStore {
  private attempts = new Map<string, AuthorizationAttemptRecord>();
  private sessions = new Map<string, SessionRecord>();
  private revisions: SessionRevisionRecord[] = [];
  private audit: AuditRecord[] = [];
  private auditFailure = false;

  failNextAudit(): void {
    this.auditFailure = true;
  }

  createAttempt(record: AuthorizationAttemptRecord): void {
    if (this.attempts.has(record.attemptId)) throw new ControlError("AUTHORIZATION_ATTEMPT_CONFLICT", 409);
    this.attempts.set(record.attemptId, Object.freeze(record));
  }

  consumeAttempt(attemptId: string, state: string, nonce: string, pkceVerifier: string, nowEpoch: number): void {
    const current = this.attempts.get(attemptId);
    if (!current || current.consumedAtEpoch !== null || current.expiresAtEpoch <= nowEpoch) {
      throw new ControlError("AUTHORIZATION_ATTEMPT_REFUSED", 401);
    }
    for (const [actual, expected] of [
      [sha256(state), current.stateDigest],
      [sha256(nonce), current.nonceDigest],
      [sha256(pkceVerifier), current.pkceVerifierDigest],
    ]) {
      const left = Buffer.from(actual);
      const right = Buffer.from(expected);
      if (left.length !== right.length || !timingSafeEqual(left, right)) throw new ControlError("AUTHORIZATION_ATTEMPT_REFUSED", 401);
    }
    this.attempts.set(attemptId, Object.freeze({ ...current, consumedAtEpoch: nowEpoch }));
  }

  createSession(record: SessionRecord, event: AuditRecord): void {
    if (this.auditFailure) {
      this.auditFailure = false;
      throw new ControlError("AUDIT_APPEND_FAILED", 503);
    }
    if ([...this.sessions.values()].some((item) => item.cookieDigest === record.cookieDigest)) {
      throw new ControlError("SESSION_CONFLICT", 409);
    }
    this.sessions.set(record.sessionId, Object.freeze(record));
    this.revisions.push(Object.freeze({
      sessionId: record.sessionId,
      organizationId: record.organizationId,
      revision: record.version,
      state: record.state,
      occurredAt: timestamp(record.issuedAtEpoch),
    }));
    this.audit.push(Object.freeze(event));
  }

  transition(sessionId: string, next: "REVOKED" | "EXPIRED", nowEpoch: number): SessionRecord {
    const current = this.sessions.get(sessionId);
    if (!current || current.state !== "ACTIVE") throw new ControlError("SESSION_NOT_FOUND", 404);
    if (this.auditFailure) {
      this.auditFailure = false;
      throw new ControlError("AUDIT_APPEND_FAILED", 503);
    }
    const revised = Object.freeze({ ...current, state: next, version: current.version + 1 });
    this.sessions.set(sessionId, revised);
    this.revisions.push(Object.freeze({
      sessionId,
      organizationId: revised.organizationId,
      revision: revised.version,
      state: next,
      occurredAt: timestamp(nowEpoch),
    }));
    this.audit.push(Object.freeze({
      eventId: crypto.randomUUID(),
      organizationId: revised.organizationId,
      eventType: `session.${next.toLowerCase()}.v1`,
      subjectDigest: revised.subjectDigest,
      aggregateDigest: sha256(canonicalJson({ sessionId, version: revised.version, state: next })),
      occurredAt: timestamp(nowEpoch),
    }));
    return revised;
  }

  authenticate(cookie: string, csrfToken: string | null, mutation: boolean, nowEpoch: number): TenantContext {
    const cookieDigest = sha256(cookie);
    const current = [...this.sessions.values()].find((item) => item.cookieDigest === cookieDigest);
    if (!current || current.state !== "ACTIVE") throw new ControlError("SESSION_REFUSED", 401);
    if (current.absoluteExpiresAtEpoch <= nowEpoch || current.idleExpiresAtEpoch <= nowEpoch) {
      this.transition(current.sessionId, "EXPIRED", nowEpoch);
      throw new ControlError("SESSION_EXPIRED", 401);
    }
    if (mutation && (!csrfToken || !digestEqual(sha256(csrfToken), current.csrfDigest))) throw new ControlError("CSRF_REFUSED", 403);
    return context(current);
  }

  getSession(sessionId: string): Readonly<SessionRecord> | undefined {
    return this.sessions.get(sessionId);
  }

  auditRecords(): readonly Readonly<AuditRecord>[] {
    return [...this.audit];
  }

  sessionRevisions(sessionId: string): readonly Readonly<SessionRevisionRecord>[] {
    return this.revisions.filter((revision) => revision.sessionId === sessionId);
  }
}

function digestEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function timestamp(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace(".000Z", "Z");
}

function context(record: SessionRecord): TenantContext {
  return Object.freeze({
    schemaVersion: FOUNDATION_SCHEMA,
    organizationId: record.organizationId,
    subjectDigest: record.subjectDigest,
    sessionId: record.sessionId,
    admissionDigest: record.admissionDigest,
    issuedAt: timestamp(record.issuedAtEpoch),
    expiresAt: timestamp(record.absoluteExpiresAtEpoch),
  });
}

function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function beginAuthorization(store: InMemorySessionStore, nowEpoch: number): AuthorizationAttemptView {
  const attemptId = crypto.randomUUID();
  const state = secret();
  const nonce = secret();
  const pkceVerifier = secret(48);
  store.createAttempt({
    attemptId,
    stateDigest: sha256(state),
    nonceDigest: sha256(nonce),
    pkceVerifierDigest: sha256(pkceVerifier),
    createdAtEpoch: nowEpoch,
    expiresAtEpoch: nowEpoch + ATTEMPT_SECONDS,
    consumedAtEpoch: null,
  });
  return Object.freeze({ attemptId, state, nonce, pkceVerifier, expiresAt: timestamp(nowEpoch + ATTEMPT_SECONDS) });
}

export function completeAuthorization(
  store: InMemorySessionStore,
  registry: OidcIssuerRegistry,
  attempt: AuthorizationAttemptView,
  supplied: { state: string; nonce: string; pkceVerifier: string; idToken: string },
  nowEpoch: number,
  replay = new MemoryReplayStore(),
): SessionStart {
  store.consumeAttempt(attempt.attemptId, supplied.state, supplied.nonce, supplied.pkceVerifier, nowEpoch);
  const principal = admitIdToken(supplied.idToken, supplied.nonce, registry, replay, nowEpoch);
  const sessionId = crypto.randomUUID();
  const cookie = secret();
  const csrfToken = secret();
  const absoluteExpiresAtEpoch = Math.min(
    Math.floor(new Date(principal.expiresAt).getTime() / 1000),
    nowEpoch + ABSOLUTE_SECONDS,
  );
  const record: SessionRecord = Object.freeze({
    sessionId,
    organizationId: principal.organizationId,
    subjectDigest: principal.subjectDigest,
    admissionDigest: principal.admissionDigest,
    cookieDigest: sha256(cookie),
    csrfDigest: sha256(csrfToken),
    issuedAtEpoch: nowEpoch,
    absoluteExpiresAtEpoch,
    idleExpiresAtEpoch: Math.min(absoluteExpiresAtEpoch, nowEpoch + IDLE_SECONDS),
    version: 1,
    state: "ACTIVE",
  });
  store.createSession(record, {
    eventId: crypto.randomUUID(),
    organizationId: record.organizationId,
    eventType: "session.started.v1",
    subjectDigest: record.subjectDigest,
    aggregateDigest: sha256(canonicalJson({ sessionId, version: 1, state: "ACTIVE" })),
    occurredAt: timestamp(nowEpoch),
  });
  return Object.freeze({ context: context(record), cookie, csrfToken });
}

export function sessionCookie(value: string, maxAgeSeconds: number): string {
  if (maxAgeSeconds < 1 || maxAgeSeconds > ABSOLUTE_SECONDS) throw new ControlError("SESSION_LIFETIME_REFUSED");
  return `__Host-planeon_session=${value}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function rejectCallerIdentity(input: {
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): void {
  const keys = [
    ...Object.keys(input.headers ?? {}),
    ...Object.keys(input.query ?? {}),
    ...Object.keys(input.body ?? {}),
    ...Object.keys(input.environment ?? {}),
  ].map((key) => key.toLowerCase());
  if (keys.some((key) => FORBIDDEN_IDENTITY.has(key))) throw new ControlError("CALLER_IDENTITY_REFUSED", 400);
}

export class TenantRowStore<T extends { readonly organizationId: string; readonly id: string }> {
  private readonly rows = new Map<string, T>();

  insert(context: TenantContext, row: T): void {
    if (!UUID.test(context.organizationId) || row.organizationId !== context.organizationId) throw new ControlError("TENANT_ROW_NOT_FOUND", 404);
    this.rows.set(`${row.organizationId}:${row.id}`, Object.freeze(row));
  }

  read(context: TenantContext, id: string): Readonly<T> {
    const value = this.rows.get(`${context.organizationId}:${id}`);
    if (!value) throw new ControlError("TENANT_ROW_NOT_FOUND", 404);
    return value;
  }
}
