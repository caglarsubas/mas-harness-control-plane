import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { gzipSync } from "node:zlib";

import { canonicalJson } from "../../apps/control-web/src/lib/foundation/canonical";
import {
  CONTRACT_AUTHORITY,
  INDUSTRY_PACK_PURPOSE,
  type IndustryPackReleaseEnvelope,
  type IndustryPackTrustRegistry,
} from "../../apps/control-web/src/lib/questionnaire/contracts";
import { releasePayload } from "../../apps/control-web/src/lib/questionnaire/pack";

const PACK_ID = "white-goods.synthetic";
const PACK_VERSION = "0.5.0";

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const journey = `apiVersion: harness.planeon.ai/industry-journey/v1alpha1
kind: IndustryJourney
stages:
  - {id: business-context, ordinal: 1, title: Business context, purpose: Establish accountable ownership.}
  - {id: domain-and-outcomes, ordinal: 2, title: Domain and outcomes, purpose: Define bounded measurable outcomes.}
  - {id: data-readiness, ordinal: 3, title: Data readiness, purpose: Prove data quality and provenance.}
  - {id: governance-and-regulation, ordinal: 4, title: Governance and regulation, purpose: Bind policies and accountability.}
  - {id: integration-readiness, ordinal: 5, title: Integration readiness, purpose: Inventory bounded integration points.}
  - {id: harness-demand, ordinal: 6, title: Harness demand, purpose: Select only required harness capabilities.}
  - {id: environment-and-provider-fit, ordinal: 7, title: Environment and provider fit, purpose: Fit local open-source providers.}
  - {id: evidence-and-acceptance, ordinal: 8, title: Evidence and acceptance, purpose: Separate evidence and acceptance states.}
`;

const questionSpecs = [
  ["business-context", "owner", "Accountable business owner", "string", ""],
  ["domain-and-outcomes", "outcome", "Primary measurable outcome", "choice", "choices: [quality, efficiency]\n    multiple: false"],
  ["data-readiness", "observation-count", "Approved observation count", "number", ""],
  ["governance-and-regulation", "policy-approved", "Is the governing policy approved?", "boolean", ""],
  ["integration-readiness", "integration-boundary", "Describe the integration boundary", "string", ""],
  ["harness-demand", "harnesses", "Select required harnesses", "choice", "choices: [domain-semantic, data-integration, governance]\n    multiple: true"],
  ["environment-and-provider-fit", "environment", "Select the managed environment", "choice", "choices: [kubernetes, openshift, virtual-machine]\n    multiple: false"],
  ["evidence-and-acceptance", "evidence-separated", "Are evidence states kept separate?", "boolean", ""],
] as const;

function questionnaire(stage: string, id: string, prompt: string, responseType: string, extra: string): string {
  return `apiVersion: harness.planeon.ai/questionnaire/v1alpha1
kind: Questionnaire
id: synthetic.${stage}
stage: ${stage}
title: ${stage} declaration
questions:
  - id: ${id}
    prompt: ${prompt}
    responseType: ${responseType}
    required: true
    ${extra}
`;
}

function tar(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [path, content] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${content.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, Buffer.from(content));
    const remainder = content.byteLength % 512;
    if (remainder) blocks.push(Buffer.alloc(512 - remainder));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

export interface SignedPackFixture {
  readonly archive: Uint8Array;
  readonly envelope: IndustryPackReleaseEnvelope;
  readonly registry: IndustryPackTrustRegistry;
}

export interface FixtureOptions {
  readonly questionnaireOverride?: string;
  readonly manifestState?: "RETAINED" | "NOT_RETAINED";
  readonly lockPayloadTampered?: boolean;
  readonly indexTampered?: boolean;
  readonly unsafePath?: boolean;
  readonly trustState?: "ACTIVE" | "REVOKED";
  readonly wrongPurpose?: boolean;
  readonly signatureTampered?: boolean;
}

export function buildSignedPackFixture(options: FixtureOptions = {}): SignedPackFixture {
  const files = new Map<string, Uint8Array>();
  const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
  const contracts = {
    apiVersion: "harness.planeon.ai/pack-contracts-lock/v1alpha1",
    kind: "PackContractsLock",
    repository: CONTRACT_AUTHORITY.repository,
    commit: CONTRACT_AUTHORITY.commit,
    releaseManifestSha256: CONTRACT_AUTHORITY.releaseManifestSha256,
    catalogDigest: CONTRACT_AUTHORITY.catalogDigest,
    schemas: [
      { path: "schemas/v1alpha1/guidance/questionnaire-answer-set.schema.json", sha256: CONTRACT_AUTHORITY.questionnaireAnswerSetSha256 },
      { path: "schemas/v1alpha1/guidance/questionnaire-definition.schema.json", sha256: CONTRACT_AUTHORITY.questionnaireDefinitionSha256 },
      { path: "schemas/v1alpha1/guidance/questionnaire-session.schema.json", sha256: CONTRACT_AUTHORITY.questionnaireSessionSha256 },
    ],
  };
  files.set("contracts.lock.json", encode(canonicalJson(contracts)));
  files.set("journey.yaml", encode(journey));

  for (const [stage, id, prompt, responseType, extra] of questionSpecs) {
    const source = stage === "business-context" && options.questionnaireOverride
      ? options.questionnaireOverride
      : questionnaire(stage, id, prompt, responseType, extra);
    files.set(`questions/${stage}.yaml`, encode(source));
  }

  const questionnaireBindings = questionSpecs.map(([stage]) => `    - {id: synthetic.${stage}, stage: ${stage}, path: questions/${stage}.yaml}`).join("\n");
  const pack = `apiVersion: harness.planeon.ai/industry-pack/v1alpha1
kind: IndustryPack
metadata: {id: ${PACK_ID}, version: ${PACK_VERSION}, title: Synthetic white-goods readiness, industry: white-goods, license: Apache-2.0, packKind: SECTOR}
compatibility:
  frameworkVersion: 0.1.0
  contractsLock: {path: contracts.lock.json, sha256: ${digest(files.get("contracts.lock.json")!)}}
journey: {path: journey.yaml, sha256: ${digest(files.get("journey.yaml")!)}}
overlayMode: APPEND_ONLY
extends: null
content:
  questionnaires:
${questionnaireBindings}
`;
  files.set("pack.yaml", encode(pack));

  const excludedPaths = ["manifest.json", "pack.index.json", "pack.lock.json"];
  const lockEntries = [...files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, content]) => ({
    path,
    size: content.byteLength,
    sha256: digest(content),
  }));
  const payloadDigest = digest(canonicalJson({ algorithm: "SHA-256", excludedPaths, entries: lockEntries }));
  const lock = {
    schemaVersion: "planeon.control.industry-pack-lock/v1alpha1",
    kind: "IndustryPackLock",
    algorithm: "SHA-256",
    canonicalization: "SORTED_UTF8_JSON_V1",
    pack: { id: PACK_ID, version: PACK_VERSION },
    excludedPaths,
    entries: lockEntries,
    payloadDigest: options.lockPayloadTampered ? "0".repeat(64) : payloadDigest,
  };
  files.set("pack.lock.json", encode(canonicalJson(lock)));
  const packLockSha256 = digest(files.get("pack.lock.json")!);
  const manifest = {
    schemaVersion: "planeon.control.industry-pack-artifact-manifest/v1alpha1",
    pack: { id: PACK_ID, version: PACK_VERSION },
    artifact: { state: options.manifestState ?? "RETAINED" },
    packLock: { path: "pack.lock.json", sha256: packLockSha256 },
    releaseSigning: { algorithm: "ED25519", state: "VERIFIED", signerId: "synthetic-release-key" },
  };
  files.set("manifest.json", encode(canonicalJson(manifest)));
  if (options.unsafePath) files.set("../escape.txt", encode("refused"));

  const mediaType = (path: string): string => path.endsWith(".json") ? "application/json" : "application/yaml";
  const indexEntries = [...files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, content], index) => ({
    path,
    mediaType: mediaType(path),
    size: content.byteLength,
    sha256: options.indexTampered && index === 0 ? "0".repeat(64) : digest(content),
  }));
  const indexSubject = {
    apiVersion: "harness.planeon.ai/pack-index/v1alpha1",
    kind: "PackIndex",
    pack: { id: PACK_ID, version: PACK_VERSION },
    files: indexEntries,
    packDigest: digest(canonicalJson(indexEntries)),
    evidence: { published: false, runtimeEvidence: false, assuranceEvidence: false, tenantAcceptance: false },
  };
  files.set("pack.index.json", encode(canonicalJson({ ...indexSubject, indexDigest: digest(canonicalJson(indexSubject)) })));

  const archive = tar(files);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const unsigned: IndustryPackReleaseEnvelope = {
    schemaVersion: "planeon.control.industry-pack-release-envelope/v1alpha1",
    algorithm: "ED25519",
    purpose: INDUSTRY_PACK_PURPOSE,
    keyId: "synthetic-release-key",
    packId: PACK_ID,
    packVersion: PACK_VERSION,
    archiveSha256: digest(archive),
    archiveSize: archive.byteLength,
    packLockSha256,
    artifactManifestSha256: digest(files.get("manifest.json")!),
    issuedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2027-01-01T00:00:00Z",
    signature: "A".repeat(86),
  };
  const validSignature = sign(null, Buffer.from(canonicalJson(releasePayload(unsigned))), privateKey).toString("base64url");
  const envelope = Object.freeze({
    ...unsigned,
    signature: options.signatureTampered
      ? `${validSignature.slice(0, -1)}${validSignature.endsWith("A") ? "B" : "A"}`
      : validSignature,
  });
  const registry = Object.freeze({
    schemaVersion: "planeon.control.industry-pack-trust-registry/v1alpha1" as const,
    keys: Object.freeze([Object.freeze({
      keyId: "synthetic-release-key",
      algorithm: "ED25519" as const,
      purpose: (options.wrongPurpose ? "TENANT_LIVE_EXECUTION" : INDUSTRY_PACK_PURPOSE) as typeof INDUSTRY_PACK_PURPOSE,
      state: options.trustState ?? "ACTIVE",
      notBefore: "2025-01-01T00:00:00Z",
      notAfter: "2028-01-01T00:00:00Z",
      publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    })]),
  });
  return { archive, envelope, registry };
}
