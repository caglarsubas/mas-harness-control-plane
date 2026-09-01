import { generateKeyPairSync, sign } from "node:crypto";

import type { OidcIssuerRegistry, PublicJwk } from "../../apps/control-web/src/lib/foundation/oidc";

export const NOW = 1_800_000_000;
export const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";

export function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  const key: PublicJwk = {
    alg: "RS256",
    e: exported.e!,
    kid: "fixture-rs256-1",
    kty: "RSA",
    n: exported.n!,
    state: "ACTIVE",
    use: "sig",
  };
  const registry: OidcIssuerRegistry = {
    schemaVersion: "planeon.control.oidc-issuer-registry/v1",
    bindings: [{
      issuer: "https://tenant-alpha.example.invalid",
      audiences: ["planeon-control"],
      organizationId: ORGANIZATION_ID,
      tenantClaimName: "tenant_ref",
      tenantClaimValue: "tenant-alpha",
      allowedAlgorithms: ["RS256"],
      maximumTokenLifetimeSeconds: 3_600,
      clockSkewSeconds: 30,
      keys: [key],
    }],
  };

  function token(overrides: Readonly<Record<string, unknown>> = {}, headerSource?: string): string {
    const header = headerSource ?? JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT" });
    const claims = JSON.stringify({
      iss: registry.bindings[0].issuer,
      aud: "planeon-control",
      sub: "synthetic-subject",
      iat: NOW - 10,
      nbf: NOW - 10,
      exp: NOW + 900,
      nonce: "fixture-nonce",
      jti: `fixture-jti-${crypto.randomUUID()}`,
      tenant_ref: "tenant-alpha",
      ...overrides,
    });
    const encodedHeader = Buffer.from(header).toString("base64url");
    const encodedClaims = Buffer.from(claims).toString("base64url");
    const input = `${encodedHeader}.${encodedClaims}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
  }
  return { registry, token };
}
