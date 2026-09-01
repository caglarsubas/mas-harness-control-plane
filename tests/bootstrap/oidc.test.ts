import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { admitIdToken, MemoryReplayStore } from "../../apps/control-web/src/lib/foundation/oidc";
import { fixture, NOW, ORGANIZATION_ID } from "./oidc-fixture";

function code(action: () => unknown, expected: string): void {
  try {
    action();
    throw new Error("expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { code: string }).code).toBe(expected);
    expect(error instanceof Error ? error.message : "").not.toContain("synthetic-subject");
  }
}

describe("offline OIDC admission", () => {
  it("derives organization and digested subject from the issuer binding", () => {
    const { registry, token } = fixture();
    const principal = admitIdToken(token(), "fixture-nonce", registry, new MemoryReplayStore(), NOW);
    expect(principal.organizationId).toBe(ORGANIZATION_ID);
    expect(principal.subjectDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(principal)).not.toContain("synthetic-subject");
  });

  it("fails closed on audience, tenant, nonce, time, duplicate header, and replay", () => {
    const { registry, token } = fixture();
    code(() => admitIdToken(token({ aud: ["planeon-control", "other"] }), "fixture-nonce", registry, new MemoryReplayStore(), NOW), "OIDC_AUDIENCE_REFUSED");
    code(() => admitIdToken(token({ tenant_ref: "tenant-beta" }), "fixture-nonce", registry, new MemoryReplayStore(), NOW), "OIDC_TENANT_REFUSED");
    code(() => admitIdToken(token(), "wrong-nonce", registry, new MemoryReplayStore(), NOW), "OIDC_NONCE_REFUSED");
    code(() => admitIdToken(token({ exp: NOW - 100 }), "fixture-nonce", registry, new MemoryReplayStore(), NOW), "OIDC_TOKEN_EXPIRED");
    code(() => admitIdToken(token({ iat: NOW - 10, exp: NOW + 7_200 }), "fixture-nonce", registry, new MemoryReplayStore(), NOW), "OIDC_LIFETIME_REFUSED");
    code(() => admitIdToken(token({}, '{"alg":"RS256","alg":"RS256","kid":"fixture-rs256-1","typ":"JWT"}'), "fixture-nonce", registry, new MemoryReplayStore(), NOW), "JSON_DUPLICATE_MEMBER");
    const replay = new MemoryReplayStore();
    const repeated = token({ jti: "one-use-jti" });
    admitIdToken(repeated, "fixture-nonce", registry, replay, NOW);
    code(() => admitIdToken(repeated, "fixture-nonce", registry, replay, NOW), "OIDC_TOKEN_REPLAYED");
  });

  it("rejects a token signed by an untrusted key", () => {
    const { registry } = fixture();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture-rs256-1", typ: "JWT" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({
      iss: registry.bindings[0].issuer,
      aud: "planeon-control",
      sub: "synthetic-subject",
      iat: NOW - 10,
      nbf: NOW - 10,
      exp: NOW + 60,
      nonce: "fixture-nonce",
      jti: "forged-jti",
      tenant_ref: "tenant-alpha",
    })).toString("base64url");
    const input = `${header}.${claims}`;
    const forged = `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
    code(() => admitIdToken(forged, "fixture-nonce", registry, new MemoryReplayStore(), NOW), "OIDC_SIGNATURE_REFUSED");
  });
});
