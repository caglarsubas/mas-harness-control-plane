import { createPublicKey, verify, type JsonWebKey as CryptoJsonWebKey } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  canonicalJson,
  closedObject,
  parseJsonNoDuplicates,
  sha256,
} from "./canonical";
import { ControlError, type AdmittedPrincipal } from "./contracts";

export interface PublicJwk {
  readonly alg: "RS256";
  readonly e: string;
  readonly kid: string;
  readonly kty: "RSA";
  readonly n: string;
  readonly state: "ACTIVE" | "REVOKED";
  readonly use: "sig";
}

export interface OidcIssuerBinding {
  readonly issuer: string;
  readonly audiences: readonly string[];
  readonly organizationId: string;
  readonly tenantClaimName: string;
  readonly tenantClaimValue: string;
  readonly allowedAlgorithms: readonly ["RS256"];
  readonly maximumTokenLifetimeSeconds: number;
  readonly clockSkewSeconds: number;
  readonly keys: readonly PublicJwk[];
}

export interface OidcIssuerRegistry {
  readonly schemaVersion: "planeon.control.oidc-issuer-registry/v1";
  readonly bindings: readonly OidcIssuerBinding[];
}

export interface ReplayStore {
  use(tokenIdDigest: string, expiresAtEpoch: number): boolean;
}

export class MemoryReplayStore implements ReplayStore {
  private readonly used = new Map<string, number>();

  use(tokenIdDigest: string, expiresAtEpoch: number): boolean {
    if (this.used.has(tokenIdDigest)) return false;
    if (this.used.size >= 4_096) return false;
    this.used.set(tokenIdDigest, expiresAtEpoch);
    return true;
  }
}

function string(value: unknown, code: string, max = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new ControlError(code);
  return value;
}

function integer(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value)) throw new ControlError(code);
  return value as number;
}

function uuid(value: unknown, code: string): string {
  const candidate = string(value, code, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(candidate)) {
    throw new ControlError(code);
  }
  return candidate;
}

function decodeSegment(segment: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(segment)) throw new ControlError("OIDC_TOKEN_MALFORMED", 401);
  try {
    const decoded = Buffer.from(segment, "base64url");
    if (decoded.toString("base64url") !== segment) throw new Error("non-canonical base64url");
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    throw new ControlError("OIDC_TOKEN_MALFORMED", 401);
  }
}

function parseHeader(segment: string): { alg: "RS256"; kid: string; typ: "JWT" } {
  const object = closedObject(parseJsonNoDuplicates(decodeSegment(segment), 2_048), ["alg", "kid", "typ"], "OIDC_HEADER");
  if (object.alg !== "RS256" || object.typ !== "JWT") throw new ControlError("OIDC_ALGORITHM_REFUSED", 401);
  return { alg: "RS256", kid: string(object.kid, "OIDC_KEY_REFUSED", 128), typ: "JWT" };
}

function parseClaims(segment: string, tenantClaimName: string): Record<string, unknown> {
  const required = ["iss", "aud", "sub", "iat", "nbf", "exp", "nonce", "jti", tenantClaimName];
  return closedObject(parseJsonNoDuplicates(decodeSegment(segment), 8_192), required, "OIDC_CLAIMS");
}

function validateBinding(binding: OidcIssuerBinding): void {
  const issuer = new URL(binding.issuer);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new ControlError("OIDC_REGISTRY_INVALID", 500);
  }
  uuid(binding.organizationId, "OIDC_REGISTRY_INVALID");
  if (!/^[a-zA-Z][a-zA-Z0-9_]{1,63}$/u.test(binding.tenantClaimName)) throw new ControlError("OIDC_REGISTRY_INVALID", 500);
  if (binding.audiences.length < 1 || binding.audiences.length !== new Set(binding.audiences).size) throw new ControlError("OIDC_REGISTRY_INVALID", 500);
  if (binding.maximumTokenLifetimeSeconds < 60 || binding.maximumTokenLifetimeSeconds > 28_800) throw new ControlError("OIDC_REGISTRY_INVALID", 500);
  if (binding.clockSkewSeconds < 0 || binding.clockSkewSeconds > 120) throw new ControlError("OIDC_REGISTRY_INVALID", 500);
  if (binding.keys.length < 1 || binding.keys.length !== new Set(binding.keys.map((key) => key.kid)).size) throw new ControlError("OIDC_REGISTRY_INVALID", 500);
}

function parseRegistryBinding(value: unknown): OidcIssuerBinding {
  const object = closedObject(value, [
    "issuer", "audiences", "organizationId", "tenantClaimName", "tenantClaimValue",
    "allowedAlgorithms", "maximumTokenLifetimeSeconds", "clockSkewSeconds", "keys",
  ], "OIDC_BINDING");
  if (!Array.isArray(object.audiences) || !object.audiences.every((item) => typeof item === "string" && item.length <= 256)) {
    throw new ControlError("OIDC_REGISTRY_INVALID", 500);
  }
  if (!Array.isArray(object.allowedAlgorithms) || object.allowedAlgorithms.length !== 1 || object.allowedAlgorithms[0] !== "RS256") {
    throw new ControlError("OIDC_REGISTRY_INVALID", 500);
  }
  if (!Array.isArray(object.keys)) throw new ControlError("OIDC_REGISTRY_INVALID", 500);
  const keys = object.keys.map((value): PublicJwk => {
    const key = closedObject(value, ["alg", "e", "kid", "kty", "n", "state", "use"], "OIDC_KEY");
    if (key.alg !== "RS256" || key.kty !== "RSA" || key.use !== "sig" || !["ACTIVE", "REVOKED"].includes(String(key.state))) {
      throw new ControlError("OIDC_REGISTRY_INVALID", 500);
    }
    return Object.freeze({
      alg: "RS256",
      e: string(key.e, "OIDC_REGISTRY_INVALID", 16),
      kid: string(key.kid, "OIDC_REGISTRY_INVALID", 128),
      kty: "RSA",
      n: string(key.n, "OIDC_REGISTRY_INVALID", 1_024),
      state: key.state as "ACTIVE" | "REVOKED",
      use: "sig",
    });
  });
  const binding: OidcIssuerBinding = Object.freeze({
    issuer: string(object.issuer, "OIDC_REGISTRY_INVALID"),
    audiences: Object.freeze(object.audiences as string[]),
    organizationId: string(object.organizationId, "OIDC_REGISTRY_INVALID", 36),
    tenantClaimName: string(object.tenantClaimName, "OIDC_REGISTRY_INVALID", 64),
    tenantClaimValue: string(object.tenantClaimValue, "OIDC_REGISTRY_INVALID", 128),
    allowedAlgorithms: Object.freeze(["RS256"] as const),
    maximumTokenLifetimeSeconds: integer(object.maximumTokenLifetimeSeconds, "OIDC_REGISTRY_INVALID"),
    clockSkewSeconds: integer(object.clockSkewSeconds, "OIDC_REGISTRY_INVALID"),
    keys: Object.freeze(keys),
  });
  validateBinding(binding);
  return binding;
}

export async function loadIssuerRegistry(path: string, root: string): Promise<OidcIssuerRegistry> {
  const absoluteRoot = await realpath(root);
  const candidate = resolve(absoluteRoot, path);
  const canonical = await realpath(candidate);
  if (!canonical.startsWith(`${absoluteRoot}/`)) throw new ControlError("OIDC_REGISTRY_PATH_REFUSED", 500);
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new ControlError("OIDC_REGISTRY_PATH_REFUSED", 500);
  const rootObject = closedObject(parseJsonNoDuplicates(await readFile(candidate, "utf8")), ["schemaVersion", "bindings"], "OIDC_REGISTRY");
  if (rootObject.schemaVersion !== "planeon.control.oidc-issuer-registry/v1" || !Array.isArray(rootObject.bindings)) {
    throw new ControlError("OIDC_REGISTRY_INVALID", 500);
  }
  const registry: OidcIssuerRegistry = Object.freeze({
    schemaVersion: "planeon.control.oidc-issuer-registry/v1",
    bindings: Object.freeze(rootObject.bindings.map(parseRegistryBinding)),
  });
  if (registry.bindings.length !== new Set(registry.bindings.map((item) => item.issuer)).size) throw new ControlError("OIDC_REGISTRY_INVALID", 500);
  return registry;
}

export function admitIdToken(
  compactToken: string,
  expectedNonce: string,
  registry: OidcIssuerRegistry,
  replayStore: ReplayStore,
  nowEpoch: number,
): AdmittedPrincipal {
  if (Buffer.byteLength(compactToken, "utf8") > 16_384) throw new ControlError("OIDC_TOKEN_TOO_LARGE", 401);
  const segments = compactToken.split(".");
  if (segments.length !== 3) throw new ControlError("OIDC_TOKEN_MALFORMED", 401);
  const header = parseHeader(segments[0]);
  const unboundClaims = parseJsonNoDuplicates(decodeSegment(segments[1]), 8_192);
  if (unboundClaims === null || typeof unboundClaims !== "object" || Array.isArray(unboundClaims)) throw new ControlError("OIDC_CLAIMS_OBJECT_REQUIRED", 401);
  const issuer = string((unboundClaims as Record<string, unknown>).iss, "OIDC_ISSUER_REFUSED");
  const binding = registry.bindings.find((item) => item.issuer === issuer);
  if (!binding) throw new ControlError("OIDC_ISSUER_REFUSED", 401);
  validateBinding(binding);
  const claims = parseClaims(segments[1], binding.tenantClaimName);
  const audience = claims.aud;
  if (typeof audience !== "string" || !binding.audiences.includes(audience)) throw new ControlError("OIDC_AUDIENCE_REFUSED", 401);
  if (claims[binding.tenantClaimName] !== binding.tenantClaimValue) throw new ControlError("OIDC_TENANT_REFUSED", 401);
  if (claims.nonce !== expectedNonce) throw new ControlError("OIDC_NONCE_REFUSED", 401);
  const issuedAt = integer(claims.iat, "OIDC_TIME_REFUSED");
  const notBefore = integer(claims.nbf, "OIDC_TIME_REFUSED");
  const expiresAt = integer(claims.exp, "OIDC_TIME_REFUSED");
  const skew = binding.clockSkewSeconds;
  if (notBefore > nowEpoch + skew) throw new ControlError("OIDC_TOKEN_EARLY", 401);
  if (expiresAt <= nowEpoch - skew) throw new ControlError("OIDC_TOKEN_EXPIRED", 401);
  if (issuedAt > nowEpoch + skew || expiresAt <= issuedAt || expiresAt - issuedAt > binding.maximumTokenLifetimeSeconds) {
    throw new ControlError("OIDC_LIFETIME_REFUSED", 401);
  }
  const key = binding.keys.find((candidate) => candidate.kid === header.kid && candidate.state === "ACTIVE");
  if (!key || key.alg !== header.alg || key.kty !== "RSA" || key.use !== "sig") throw new ControlError("OIDC_KEY_REFUSED", 401);
  let valid = false;
  try {
    const publicKey: CryptoJsonWebKey = {
      e: key.e,
      kty: key.kty,
      n: key.n,
    };
    valid = verify(
      "RSA-SHA256",
      Buffer.from(`${segments[0]}.${segments[1]}`, "ascii"),
      createPublicKey({ key: publicKey, format: "jwk" }),
      Buffer.from(segments[2], "base64url"),
    );
  } catch {
    throw new ControlError("OIDC_SIGNATURE_REFUSED", 401);
  }
  if (!valid) throw new ControlError("OIDC_SIGNATURE_REFUSED", 401);
  const subjectDigest = sha256(string(claims.sub, "OIDC_SUBJECT_REFUSED"));
  const tokenIdDigest = sha256(string(claims.jti, "OIDC_TOKEN_ID_REFUSED"));
  if (!replayStore.use(tokenIdDigest, expiresAt)) throw new ControlError("OIDC_TOKEN_REPLAYED", 401);
  const issuedAtText = new Date(issuedAt * 1000).toISOString().replace(".000Z", "Z");
  const expiresAtText = new Date(expiresAt * 1000).toISOString().replace(".000Z", "Z");
  return {
    organizationId: binding.organizationId,
    subjectDigest,
    tokenIdDigest,
    issuedAt: issuedAtText,
    expiresAt: expiresAtText,
    admissionDigest: sha256(canonicalJson({
      organizationId: binding.organizationId,
      subjectDigest,
      tokenIdDigest,
      issuedAt: issuedAtText,
      expiresAt: expiresAtText,
    })),
  };
}
