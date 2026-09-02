import { describe, expect, it } from "vitest";

import { ControlError, FOUNDATION_SCHEMA } from "../../apps/control-web/src/lib/foundation/contracts";
import {
  beginAuthorization,
  completeAuthorization,
  InMemorySessionStore,
  rejectCallerIdentity,
  sessionCookie,
  TenantRowStore,
} from "../../apps/control-web/src/lib/foundation/session";
import { fixture, NOW, ORGANIZATION_ID } from "./oidc-fixture";

describe("authorization attempt and session", () => {
  it("stores one-use digests, emits a secure opaque cookie, and derives tenant context", () => {
    const store = new InMemorySessionStore();
    const attempt = beginAuthorization(store, NOW);
    const { registry, token } = fixture();
    const started = completeAuthorization(store, registry, attempt, {
      state: attempt.state,
      nonce: attempt.nonce,
      pkceVerifier: attempt.pkceVerifier,
      idToken: token({ nonce: attempt.nonce }),
    }, NOW);
    expect(started.context.organizationId).toBe(ORGANIZATION_ID);
    expect(JSON.stringify(store.getSession(started.context.sessionId))).not.toContain(started.cookie);
    expect(JSON.stringify(store.getSession(started.context.sessionId))).not.toContain(started.csrfToken);
    expect(sessionCookie(started.cookie, 1_800)).toContain("Path=/; Secure; HttpOnly; SameSite=Lax");
    expect(() => store.authenticate(started.cookie, null, true, NOW + 1)).toThrowError(expect.objectContaining({ code: "CSRF_REFUSED" }));
    expect(store.authenticate(started.cookie, started.csrfToken, true, NOW + 1)).toEqual(started.context);
    expect(() => completeAuthorization(store, registry, attempt, {
      state: attempt.state,
      nonce: attempt.nonce,
      pkceVerifier: attempt.pkceVerifier,
      idToken: token({ nonce: attempt.nonce }),
    }, NOW)).toThrowError(expect.objectContaining({ code: "AUTHORIZATION_ATTEMPT_REFUSED" }));
  });

  it("rolls back session creation on audit failure and revokes atomically", () => {
    const store = new InMemorySessionStore();
    const attempt = beginAuthorization(store, NOW);
    const { registry, token } = fixture();
    store.failNextAudit();
    expect(() => completeAuthorization(store, registry, attempt, {
      state: attempt.state,
      nonce: attempt.nonce,
      pkceVerifier: attempt.pkceVerifier,
      idToken: token({ nonce: attempt.nonce }),
    }, NOW)).toThrowError(expect.objectContaining({ code: "AUDIT_APPEND_FAILED" }));
    expect(store.auditRecords()).toHaveLength(0);

    const second = beginAuthorization(store, NOW);
    const started = completeAuthorization(store, registry, second, {
      state: second.state,
      nonce: second.nonce,
      pkceVerifier: second.pkceVerifier,
      idToken: token({ nonce: second.nonce }),
    }, NOW);
    store.transition(started.context.sessionId, "REVOKED", NOW + 1);
    expect(store.sessionRevisions(started.context.sessionId).map((revision) => revision.state)).toEqual(["ACTIVE", "REVOKED"]);
    expect(() => store.authenticate(started.cookie, null, false, NOW + 2)).toThrowError(expect.objectContaining({ code: "SESSION_REFUSED" }));
  });

  it("rejects caller identity and provides indistinguishable tenant row denial", () => {
    expect(() => rejectCallerIdentity({ headers: { "X-Tenant-Id": "tenant-beta" } })).toThrowError(expect.objectContaining({ code: "CALLER_IDENTITY_REFUSED" }));
    expect(() => rejectCallerIdentity({ environment: { organizationId: "tenant-beta" } })).toThrowError(expect.objectContaining({ code: "CALLER_IDENTITY_REFUSED" }));
    const rows = new TenantRowStore<{ organizationId: string; id: string; value: string }>();
    const alpha = {
      schemaVersion: FOUNDATION_SCHEMA,
      organizationId: ORGANIZATION_ID,
      subjectDigest: `sha256:${"1".repeat(64)}`,
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      admissionDigest: `sha256:${"2".repeat(64)}`,
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-01-01T01:00:00Z",
    } as const;
    rows.insert(alpha, { organizationId: ORGANIZATION_ID, id: "row-1", value: "visible" });
    const beta = { ...alpha, organizationId: "22222222-2222-4222-8222-222222222222" };
    expect(rows.read(alpha, "row-1").value).toBe("visible");
    try {
      rows.read(beta, "row-1");
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(ControlError);
      expect((error as ControlError).code).toBe("TENANT_ROW_NOT_FOUND");
      expect((error as ControlError).status).toBe(404);
    }
  });
});
