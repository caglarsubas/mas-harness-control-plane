import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

import {
  canonicalJson,
  closedObject,
  parseJsonNoDuplicates,
  sha256,
} from "../foundation/canonical";
import { ControlError } from "../foundation/contracts";
import { readBoundedTarGzip } from "./archive";
import {
  CONTRACT_AUTHORITY,
  INDUSTRY_PACK_PURPOSE,
  JOURNEY_STAGES,
  QUESTIONNAIRE_SCHEMA,
  type AdmittedIndustryPack,
  type IndustryPackReleaseEnvelope,
  type IndustryPackReleasePayload,
  type IndustryPackTrustKey,
  type IndustryPackTrustRegistry,
  type QuestionDefinition,
  type QuestionResponseType,
  type StageDefinition,
  type StageId,
} from "./contracts";

const REQUIRED_FILES = [
  "contracts.lock.json",
  "journey.yaml",
  "manifest.json",
  "pack.index.json",
  "pack.lock.json",
  "pack.yaml",
] as const;
const STAGE_IDS = new Set<string>(JOURNEY_STAGES.map((stage) => stage.id));
const STABLE_ID = /^[a-z0-9][a-z0-9.-]{1,127}$/u;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const SHA = /^[0-9a-f]{64}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const ALLOWED_PACK_CONTENT = new Set([
  "questionnaires", "rules", "readiness", "ontologies", "controls", "providerPreferences", "fixtures",
]);

function digest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function string(value: unknown, code: string, max = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw new ControlError(code, 422);
  return value;
}

function integer(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ControlError(code, 422);
  return Number(value);
}

function timestamp(value: unknown, code: string): { text: string; epoch: number } {
  const text = string(value, code, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(text)) throw new ControlError(code, 422);
  const epoch = Date.parse(text) / 1000;
  if (!Number.isSafeInteger(epoch)) throw new ControlError(code, 422);
  return { text, epoch };
}

function exactObject(value: unknown, required: readonly string[], code: string): Record<string, unknown> {
  try {
    return closedObject(value, required, code);
  } catch {
    throw new ControlError(`${code}_REFUSED`, 422);
  }
}

function parseJsonFile(files: ReadonlyMap<string, Uint8Array>, path: string): unknown {
  const bytes = files.get(path);
  if (!bytes) throw new ControlError("PACK_REQUIRED_FILE_MISSING", 422);
  try {
    return parseJsonNoDuplicates(new TextDecoder().decode(bytes), 2 * 1024 * 1024);
  } catch {
    throw new ControlError("PACK_JSON_REFUSED", 422);
  }
}

function parseYamlFile(files: ReadonlyMap<string, Uint8Array>, path: string): unknown {
  const bytes = files.get(path);
  if (!bytes) throw new ControlError("PACK_REQUIRED_FILE_MISSING", 422);
  const source = new TextDecoder().decode(bytes);
  if (/(^|[\s[{,:])(?:[&*][A-Za-z0-9_-]+|![^\s])/mu.test(source)) {
    throw new ControlError("PACK_YAML_FEATURE_REFUSED", 422);
  }
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      schema: "core",
      uniqueKeys: true,
      version: "1.2",
    });
    if (document.errors.length > 0 || document.warnings.length > 0) throw new Error("yaml diagnostics");
    return document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new ControlError("PACK_YAML_REFUSED", 422);
  }
}

export function releasePayload(envelope: IndustryPackReleaseEnvelope): IndustryPackReleasePayload {
  return Object.freeze({
    purpose: envelope.purpose,
    keyId: envelope.keyId,
    packId: envelope.packId,
    packVersion: envelope.packVersion,
    archiveSha256: envelope.archiveSha256,
    archiveSize: envelope.archiveSize,
    packLockSha256: envelope.packLockSha256,
    artifactManifestSha256: envelope.artifactManifestSha256,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
  });
}

export function parseReleaseEnvelope(value: unknown): IndustryPackReleaseEnvelope {
  const object = exactObject(value, [
    "schemaVersion", "algorithm", "purpose", "keyId", "packId", "packVersion", "archiveSha256",
    "archiveSize", "packLockSha256", "artifactManifestSha256", "issuedAt", "expiresAt", "signature",
  ], "PACK_RELEASE_ENVELOPE");
  if (
    object.schemaVersion !== "planeon.control.industry-pack-release-envelope/v1alpha1" ||
    object.algorithm !== "ED25519" || object.purpose !== INDUSTRY_PACK_PURPOSE
  ) {
    throw new ControlError("PACK_RELEASE_ENVELOPE_REFUSED", 422);
  }
  const keyId = string(object.keyId, "PACK_RELEASE_KEY_REFUSED", 128);
  const packId = string(object.packId, "PACK_ID_REFUSED", 128);
  const packVersion = string(object.packVersion, "PACK_VERSION_REFUSED", 32);
  const archiveSha256 = string(object.archiveSha256, "PACK_ARCHIVE_DIGEST_REFUSED", 64);
  const packLockSha256 = string(object.packLockSha256, "PACK_LOCK_DIGEST_REFUSED", 64);
  const artifactManifestSha256 = string(object.artifactManifestSha256, "PACK_MANIFEST_DIGEST_REFUSED", 64);
  const signature = string(object.signature, "PACK_SIGNATURE_REFUSED", 256);
  timestamp(object.issuedAt, "PACK_RELEASE_TIME_REFUSED");
  timestamp(object.expiresAt, "PACK_RELEASE_TIME_REFUSED");
  if (!KEY_ID.test(keyId) || !STABLE_ID.test(packId) || !SEMVER.test(packVersion)) throw new ControlError("PACK_RELEASE_IDENTITY_REFUSED", 422);
  if (![archiveSha256, packLockSha256, artifactManifestSha256].every((item) => SHA.test(item))) {
    throw new ControlError("PACK_RELEASE_DIGEST_REFUSED", 422);
  }
  if (!/^[A-Za-z0-9_-]{64,128}$/u.test(signature)) throw new ControlError("PACK_SIGNATURE_REFUSED", 422);
  return Object.freeze({
    schemaVersion: "planeon.control.industry-pack-release-envelope/v1alpha1",
    algorithm: "ED25519",
    purpose: INDUSTRY_PACK_PURPOSE,
    keyId,
    packId,
    packVersion,
    archiveSha256,
    archiveSize: integer(object.archiveSize, "PACK_ARCHIVE_SIZE_REFUSED"),
    packLockSha256,
    artifactManifestSha256,
    issuedAt: String(object.issuedAt),
    expiresAt: String(object.expiresAt),
    signature,
  });
}

function trustKey(value: unknown): IndustryPackTrustKey {
  const object = exactObject(value, [
    "keyId", "algorithm", "purpose", "state", "notBefore", "notAfter", "publicKeyPem",
  ], "PACK_TRUST_KEY");
  const keyId = string(object.keyId, "PACK_TRUST_KEY_REFUSED", 128);
  const publicKeyPem = string(object.publicKeyPem, "PACK_TRUST_KEY_REFUSED", 4_096);
  if (
    !KEY_ID.test(keyId) || object.algorithm !== "ED25519" || object.purpose !== INDUSTRY_PACK_PURPOSE ||
    !["ACTIVE", "REVOKED"].includes(String(object.state))
  ) {
    throw new ControlError("PACK_TRUST_KEY_REFUSED", 422);
  }
  const notBefore = timestamp(object.notBefore, "PACK_TRUST_TIME_REFUSED").text;
  const notAfter = timestamp(object.notAfter, "PACK_TRUST_TIME_REFUSED").text;
  try {
    if (createPublicKey(publicKeyPem).asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
  } catch {
    throw new ControlError("PACK_TRUST_KEY_REFUSED", 422);
  }
  return Object.freeze({
    keyId,
    algorithm: "ED25519",
    purpose: INDUSTRY_PACK_PURPOSE,
    state: object.state as "ACTIVE" | "REVOKED",
    notBefore,
    notAfter,
    publicKeyPem,
  });
}

export function parseTrustRegistry(value: unknown): IndustryPackTrustRegistry {
  const object = exactObject(value, ["schemaVersion", "keys"], "PACK_TRUST_REGISTRY");
  if (object.schemaVersion !== "planeon.control.industry-pack-trust-registry/v1alpha1" || !Array.isArray(object.keys)) {
    throw new ControlError("PACK_TRUST_REGISTRY_REFUSED", 422);
  }
  const keys = object.keys.map(trustKey);
  if (keys.length < 1 || keys.length > 64 || keys.length !== new Set(keys.map((key) => key.keyId)).size) {
    throw new ControlError("PACK_TRUST_REGISTRY_REFUSED", 422);
  }
  return Object.freeze({
    schemaVersion: "planeon.control.industry-pack-trust-registry/v1alpha1",
    keys: Object.freeze(keys),
  });
}

export async function loadIndustryPackTrustRegistry(path: string, root: string): Promise<IndustryPackTrustRegistry> {
  const authorityRoot = await realpath(root);
  const candidate = resolve(authorityRoot, path);
  const canonical = await realpath(candidate);
  if (!canonical.startsWith(`${authorityRoot}/`)) throw new ControlError("PACK_TRUST_PATH_REFUSED", 500);
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new ControlError("PACK_TRUST_PATH_REFUSED", 500);
  return parseTrustRegistry(parseJsonNoDuplicates(await readFile(candidate, "utf8"), 65_536));
}

function verifyRelease(
  envelope: IndustryPackReleaseEnvelope,
  archive: Uint8Array,
  registry: IndustryPackTrustRegistry,
  nowEpoch: number,
): void {
  if (envelope.archiveSize !== archive.byteLength || envelope.archiveSha256 !== digest(archive)) {
    throw new ControlError("PACK_ARCHIVE_BINDING_REFUSED", 422);
  }
  const issuedAt = timestamp(envelope.issuedAt, "PACK_RELEASE_TIME_REFUSED").epoch;
  const expiresAt = timestamp(envelope.expiresAt, "PACK_RELEASE_TIME_REFUSED").epoch;
  if (issuedAt > nowEpoch || expiresAt <= nowEpoch || expiresAt <= issuedAt || expiresAt - issuedAt > 31_536_000) {
    throw new ControlError("PACK_RELEASE_TIME_REFUSED", 422);
  }
  const key = registry.keys.find((candidate) => candidate.keyId === envelope.keyId);
  if (!key) throw new ControlError("PACK_RELEASE_KEY_UNKNOWN", 422);
  if (key.state !== "ACTIVE") throw new ControlError("PACK_RELEASE_KEY_REVOKED", 422);
  if (key.algorithm !== envelope.algorithm || key.purpose !== envelope.purpose) throw new ControlError("PACK_RELEASE_PURPOSE_REFUSED", 422);
  if (timestamp(key.notBefore, "PACK_TRUST_TIME_REFUSED").epoch > issuedAt || timestamp(key.notAfter, "PACK_TRUST_TIME_REFUSED").epoch < expiresAt) {
    throw new ControlError("PACK_RELEASE_KEY_TIME_REFUSED", 422);
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(envelope.signature, "base64url");
    if (signature.toString("base64url") !== envelope.signature) throw new Error("non-canonical signature");
  } catch {
    throw new ControlError("PACK_SIGNATURE_REFUSED", 422);
  }
  if (!verify(null, Buffer.from(canonicalJson(releasePayload(envelope))), createPublicKey(key.publicKeyPem), signature)) {
    throw new ControlError("PACK_SIGNATURE_REFUSED", 422);
  }
}

interface IndexEntry { readonly path: string; readonly mediaType: string; readonly size: number; readonly sha256: string }

function indexEntries(value: unknown, files: ReadonlyMap<string, Uint8Array>, packId: string, packVersion: string): readonly IndexEntry[] {
  const index = exactObject(value, ["apiVersion", "kind", "pack", "files", "packDigest", "indexDigest", "evidence"], "PACK_INDEX");
  const identity = exactObject(index.pack, ["id", "version"], "PACK_INDEX_IDENTITY");
  const evidence = exactObject(index.evidence, ["published", "runtimeEvidence", "assuranceEvidence", "tenantAcceptance"], "PACK_INDEX_EVIDENCE");
  if (
    index.apiVersion !== "harness.planeon.ai/pack-index/v1alpha1" || index.kind !== "PackIndex" ||
    identity.id !== packId || identity.version !== packVersion || !Array.isArray(index.files) ||
    Object.values(evidence).some((state) => state !== false)
  ) {
    throw new ControlError("PACK_INDEX_REFUSED", 422);
  }
  const entries = index.files.map((value): IndexEntry => {
    const item = exactObject(value, ["path", "mediaType", "size", "sha256"], "PACK_INDEX_ENTRY");
    const path = string(item.path, "PACK_INDEX_REFUSED", 240);
    const mediaType = string(item.mediaType, "PACK_INDEX_REFUSED", 128);
    const size = integer(item.size, "PACK_INDEX_REFUSED");
    const itemDigest = string(item.sha256, "PACK_INDEX_REFUSED", 64);
    if (!SHA.test(itemDigest)) throw new ControlError("PACK_INDEX_REFUSED", 422);
    return Object.freeze({ path, mediaType, size, sha256: itemDigest });
  });
  if (entries.length !== new Set(entries.map((item) => item.path)).size) throw new ControlError("PACK_INDEX_REFUSED", 422);
  const expectedPaths = [...files.keys()].filter((path) => path !== "pack.index.json").sort();
  if (canonicalJson(entries.map((item) => item.path)) !== canonicalJson(expectedPaths)) throw new ControlError("PACK_INDEX_INVENTORY_REFUSED", 422);
  for (const entry of entries) {
    const bytes = files.get(entry.path);
    if (!bytes || bytes.byteLength !== entry.size || digest(bytes) !== entry.sha256) throw new ControlError("PACK_INDEX_BINDING_REFUSED", 422);
  }
  if (index.packDigest !== digest(canonicalJson(entries))) throw new ControlError("PACK_INDEX_PACK_DIGEST_REFUSED", 422);
  const indexSubject = {
    apiVersion: index.apiVersion,
    kind: index.kind,
    pack: identity,
    files: entries,
    packDigest: index.packDigest,
    evidence,
  };
  if (index.indexDigest !== digest(canonicalJson(indexSubject))) throw new ControlError("PACK_INDEX_SELF_DIGEST_REFUSED", 422);
  return Object.freeze(entries);
}

function verifyLock(value: unknown, files: ReadonlyMap<string, Uint8Array>, packId: string, packVersion: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ControlError("PACK_LOCK_REFUSED", 422);
  const lock = value as Record<string, unknown>;
  const allowedLock = new Set([
    "schemaVersion", "apiVersion", "kind", "id", "stage", "algorithm", "canonicalization", "pack",
    "excludedPaths", "entries", "payloadDigest", "licenseDisposition",
  ]);
  if (Object.keys(lock).some((key) => !allowedLock.has(key))) throw new ControlError("PACK_LOCK_REFUSED", 422);
  const identity = exactObject(lock.pack, ["id", "version"], "PACK_LOCK_IDENTITY");
  const excluded = lock.excludedPaths;
  if (
    !["planeon.control.industry-pack-lock/v1alpha1", "harness.planeon.ai/industry-pack-lock/v1alpha1"].includes(String(lock.schemaVersion ?? lock.apiVersion)) ||
    lock.kind !== "IndustryPackLock" ||
    lock.algorithm !== "SHA-256" || lock.canonicalization !== "SORTED_UTF8_JSON_V1" || identity.id !== packId ||
    identity.version !== packVersion || !Array.isArray(excluded) ||
    ![["manifest.json", "pack.lock.json"], ["manifest.json", "pack.index.json", "pack.lock.json"]]
      .some((accepted) => canonicalJson(excluded) === canonicalJson(accepted)) || !Array.isArray(lock.entries)
  ) {
    throw new ControlError("PACK_LOCK_REFUSED", 422);
  }
  const entries = lock.entries.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ControlError("PACK_LOCK_REFUSED", 422);
    const item = value as Record<string, unknown>;
    const allowed = new Set(["path", "size", "sha256", "mediaType", "license"]);
    if (Object.keys(item).some((key) => !allowed.has(key)) || !["path", "size", "sha256"].every((key) => key in item)) {
      throw new ControlError("PACK_LOCK_REFUSED", 422);
    }
    const normalized: Record<string, unknown> = {
      path: string(item.path, "PACK_LOCK_REFUSED", 240),
      size: integer(item.size, "PACK_LOCK_REFUSED"),
      sha256: string(item.sha256, "PACK_LOCK_REFUSED", 64),
    };
    if ("license" in item) normalized.license = string(item.license, "PACK_LOCK_REFUSED", 64);
    if ("mediaType" in item) normalized.mediaType = string(item.mediaType, "PACK_LOCK_REFUSED", 128);
    return Object.freeze(normalized);
  });
  const expectedPaths = [...files.keys()].filter((path) => path !== "pack.index.json" && !(excluded as string[]).includes(path)).sort();
  if (canonicalJson(entries.map((item) => item.path)) !== canonicalJson(expectedPaths)) throw new ControlError("PACK_LOCK_INVENTORY_REFUSED", 422);
  for (const entry of entries) {
    const bytes = files.get(String(entry.path));
    if (!bytes || bytes.byteLength !== entry.size || digest(bytes) !== entry.sha256 || !SHA.test(String(entry.sha256))) {
      throw new ControlError("PACK_LOCK_BINDING_REFUSED", 422);
    }
  }
  const payloadDigest = digest(canonicalJson({ algorithm: lock.algorithm, excludedPaths: excluded, entries }));
  if (lock.payloadDigest !== payloadDigest) throw new ControlError("PACK_LOCK_PAYLOAD_REFUSED", 422);
}

function verifyManifest(value: unknown, packId: string, packVersion: string, packLockSha256: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ControlError("PACK_MANIFEST_RELEASE_REFUSED", 422);
  const manifest = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion", "apiVersion", "kind", "id", "stage", "pack", "artifact", "packLock", "releaseSigning",
    "evidenceBoundary", "licenseDisposition", "sourceProvenance",
  ]);
  if (Object.keys(manifest).some((key) => !allowed.has(key))) throw new ControlError("PACK_MANIFEST_RELEASE_REFUSED", 422);
  const identity = exactObject(manifest.pack, ["id", "version"], "PACK_MANIFEST_IDENTITY");
  if (manifest.artifact === null || typeof manifest.artifact !== "object" || Array.isArray(manifest.artifact)) throw new ControlError("PACK_MANIFEST_RELEASE_REFUSED", 422);
  if (manifest.packLock === null || typeof manifest.packLock !== "object" || Array.isArray(manifest.packLock)) throw new ControlError("PACK_MANIFEST_RELEASE_REFUSED", 422);
  if (manifest.releaseSigning === null || typeof manifest.releaseSigning !== "object" || Array.isArray(manifest.releaseSigning)) throw new ControlError("PACK_MANIFEST_RELEASE_REFUSED", 422);
  const artifact = manifest.artifact as Record<string, unknown>;
  const packLock = manifest.packLock as Record<string, unknown>;
  const signing = manifest.releaseSigning as Record<string, unknown>;
  if (
    !["planeon.control.industry-pack-artifact-manifest/v1alpha1", "harness.planeon.ai/industry-pack-artifact-manifest/v1alpha1"]
      .includes(String(manifest.schemaVersion ?? manifest.apiVersion)) ||
    identity.id !== packId || identity.version !== packVersion || artifact.state !== "RETAINED" ||
    packLock.path !== "pack.lock.json" || packLock.sha256 !== packLockSha256 ||
    signing.algorithm !== "ED25519" || signing.state !== "VERIFIED" || typeof signing.signerId !== "string"
  ) {
    throw new ControlError("PACK_MANIFEST_RELEASE_REFUSED", 422);
  }
}

function verifyContracts(value: unknown): void {
  const lock = exactObject(value, [
    "apiVersion", "kind", "repository", "commit", "releaseManifestSha256", "catalogDigest", "schemas",
  ], "PACK_CONTRACTS_LOCK");
  if (
    lock.apiVersion !== "harness.planeon.ai/pack-contracts-lock/v1alpha1" || lock.kind !== "PackContractsLock" ||
    lock.repository !== CONTRACT_AUTHORITY.repository || lock.commit !== CONTRACT_AUTHORITY.commit ||
    lock.releaseManifestSha256 !== CONTRACT_AUTHORITY.releaseManifestSha256 || lock.catalogDigest !== CONTRACT_AUTHORITY.catalogDigest ||
    !Array.isArray(lock.schemas)
  ) {
    throw new ControlError("PACK_CONTRACTS_LOCK_REFUSED", 422);
  }
  const required = new Map([
    ["schemas/v1alpha1/guidance/questionnaire-definition.schema.json", CONTRACT_AUTHORITY.questionnaireDefinitionSha256],
  ]);
  for (const entry of lock.schemas) {
    const object = exactObject(entry, ["path", "sha256"], "PACK_CONTRACT_SCHEMA");
    const expected = required.get(String(object.path));
    if (expected && object.sha256 === expected) required.delete(String(object.path));
  }
  if (required.size > 0) throw new ControlError("PACK_CONTRACT_SCHEMAS_REFUSED", 422);
}

function journey(value: unknown): readonly Omit<StageDefinition, "questions">[] {
  const object = exactObject(value, ["apiVersion", "kind", "stages"], "PACK_JOURNEY");
  if (object.apiVersion !== "harness.planeon.ai/industry-journey/v1alpha1" || object.kind !== "IndustryJourney" || !Array.isArray(object.stages)) {
    throw new ControlError("PACK_JOURNEY_REFUSED", 422);
  }
  const stages = object.stages.map((value) => {
    const stage = exactObject(value, ["id", "ordinal", "title", "purpose"], "PACK_JOURNEY_STAGE");
    return Object.freeze({
      id: string(stage.id, "PACK_JOURNEY_REFUSED", 64) as StageId,
      title: string(stage.title, "PACK_JOURNEY_REFUSED", 128),
      purpose: string(stage.purpose, "PACK_JOURNEY_REFUSED", 512),
      ordinal: integer(stage.ordinal, "PACK_JOURNEY_REFUSED"),
    });
  });
  if (canonicalJson(stages.map(({ id, ordinal }) => ({ id, ordinal }))) !== canonicalJson(JOURNEY_STAGES.map((stage, index) => ({ id: stage.id, ordinal: index + 1 })))) {
    throw new ControlError("PACK_JOURNEY_ORDER_REFUSED", 422);
  }
  return Object.freeze(stages.map(({ id, title, purpose }) => Object.freeze({ id, title, purpose })));
}

function questionnaire(value: unknown, expectedId: string, expectedStage: StageId): readonly QuestionDefinition[] {
  const root = exactObject(value, ["apiVersion", "kind", "id", "stage", "title", "questions"], "PACK_QUESTIONNAIRE");
  if (
    root.apiVersion !== "harness.planeon.ai/questionnaire/v1alpha1" || root.kind !== "Questionnaire" ||
    root.id !== expectedId || root.stage !== expectedStage || !Array.isArray(root.questions) || root.questions.length < 1
  ) {
    throw new ControlError("PACK_QUESTIONNAIRE_REFUSED", 422);
  }
  return Object.freeze(root.questions.map((value): QuestionDefinition => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ControlError("PACK_QUESTION_REFUSED", 422);
    const object = value as Record<string, unknown>;
    const allowed = new Set(["id", "prompt", "responseType", "required", "choices", "multiple"]);
    if (Object.keys(object).some((key) => !allowed.has(key)) || !["id", "prompt", "responseType", "required"].every((key) => key in object)) {
      throw new ControlError("PACK_QUESTION_REFUSED", 422);
    }
    const sourceType = string(object.responseType, "PACK_QUESTION_REFUSED", 32);
    let responseType: QuestionResponseType;
    if (["string", "number", "boolean"].includes(sourceType)) responseType = sourceType as QuestionResponseType;
    else if (sourceType === "choice" && object.multiple === false) responseType = "single-choice";
    else if (sourceType === "choice" && object.multiple === true) responseType = "multiple-choice";
    else throw new ControlError("PACK_QUESTION_TYPE_REFUSED", 422);
    const options = object.choices === undefined ? [] : object.choices;
    if (!Array.isArray(options) || !options.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128)) {
      throw new ControlError("PACK_QUESTION_OPTIONS_REFUSED", 422);
    }
    if ((responseType.endsWith("choice") && options.length < 1) || (!responseType.endsWith("choice") && options.length > 0)) {
      throw new ControlError("PACK_QUESTION_OPTIONS_REFUSED", 422);
    }
    const uniqueOptions = Object.freeze([...options] as string[]);
    if (uniqueOptions.length !== new Set(uniqueOptions).size || typeof object.required !== "boolean") {
      throw new ControlError("PACK_QUESTION_REFUSED", 422);
    }
    const id = string(object.id, "PACK_QUESTION_REFUSED", 128);
    if (!STABLE_ID.test(id)) throw new ControlError("PACK_QUESTION_REFUSED", 422);
    return Object.freeze({
      id,
      prompt: string(object.prompt, "PACK_QUESTION_REFUSED", 1_024),
      responseType,
      required: object.required,
      options: uniqueOptions,
    });
  }));
}

function projection(
  files: ReadonlyMap<string, Uint8Array>,
  envelope: IndustryPackReleaseEnvelope,
  admittedAt: string,
): AdmittedIndustryPack {
  for (const path of REQUIRED_FILES) if (!files.has(path)) throw new ControlError("PACK_REQUIRED_FILE_MISSING", 422);
  indexEntries(parseJsonFile(files, "pack.index.json"), files, envelope.packId, envelope.packVersion);
  if (digest(files.get("pack.lock.json")!) !== envelope.packLockSha256) throw new ControlError("PACK_LOCK_ENVELOPE_BINDING_REFUSED", 422);
  if (digest(files.get("manifest.json")!) !== envelope.artifactManifestSha256) throw new ControlError("PACK_MANIFEST_ENVELOPE_BINDING_REFUSED", 422);
  verifyLock(parseJsonFile(files, "pack.lock.json"), files, envelope.packId, envelope.packVersion);
  verifyManifest(parseJsonFile(files, "manifest.json"), envelope.packId, envelope.packVersion, envelope.packLockSha256);
  verifyContracts(parseJsonFile(files, "contracts.lock.json"));

  const pack = exactObject(parseYamlFile(files, "pack.yaml"), [
    "apiVersion", "kind", "metadata", "compatibility", "journey", "overlayMode", "extends", "content",
  ], "PACK_DOCUMENT");
  const metadata = exactObject(pack.metadata, ["id", "version", "title", "industry", "license", "packKind"], "PACK_METADATA");
  const compatibility = exactObject(pack.compatibility, ["frameworkVersion", "contractsLock"], "PACK_COMPATIBILITY");
  const contractsBinding = exactObject(compatibility.contractsLock, ["path", "sha256"], "PACK_CONTRACT_BINDING");
  const journeyBinding = exactObject(pack.journey, ["path", "sha256"], "PACK_JOURNEY_BINDING");
  if (
    pack.apiVersion !== "harness.planeon.ai/industry-pack/v1alpha1" || pack.kind !== "IndustryPack" ||
    metadata.id !== envelope.packId || metadata.version !== envelope.packVersion || metadata.license !== "Apache-2.0" ||
    contractsBinding.path !== "contracts.lock.json" || contractsBinding.sha256 !== digest(files.get("contracts.lock.json")!) ||
    journeyBinding.path !== "journey.yaml" || journeyBinding.sha256 !== digest(files.get("journey.yaml")!)
  ) {
    throw new ControlError("PACK_DOCUMENT_BINDING_REFUSED", 422);
  }
  if (pack.content === null || typeof pack.content !== "object" || Array.isArray(pack.content)) throw new ControlError("PACK_CONTENT_REFUSED", 422);
  const content = pack.content as Record<string, unknown>;
  if (Object.keys(content).some((key) => !ALLOWED_PACK_CONTENT.has(key)) || !Array.isArray(content.questionnaires)) {
    throw new ControlError("PACK_CONTENT_REFUSED", 422);
  }
  const stageDefinitions = journey(parseYamlFile(files, "journey.yaml"));
  const questions = new Map<StageId, QuestionDefinition[]>();
  const questionIds = new Set<string>();
  const questionnaireIds = new Set<string>();
  for (const value of content.questionnaires) {
    const item = exactObject(value, ["id", "stage", "path"], "PACK_QUESTIONNAIRE_BINDING");
    const id = string(item.id, "PACK_QUESTIONNAIRE_BINDING_REFUSED", 128);
    const stage = string(item.stage, "PACK_QUESTIONNAIRE_BINDING_REFUSED", 64) as StageId;
    const path = string(item.path, "PACK_QUESTIONNAIRE_BINDING_REFUSED", 240);
    if (!STABLE_ID.test(id) || !STAGE_IDS.has(stage) || questionnaireIds.has(id) || !files.has(path)) {
      throw new ControlError("PACK_QUESTIONNAIRE_BINDING_REFUSED", 422);
    }
    questionnaireIds.add(id);
    const parsed = questionnaire(parseYamlFile(files, path), id, stage);
    for (const question of parsed) {
      if (questionIds.has(question.id)) throw new ControlError("PACK_QUESTION_ID_DUPLICATE", 422);
      questionIds.add(question.id);
      questions.set(stage, [...(questions.get(stage) ?? []), question]);
    }
  }
  const stages = Object.freeze(stageDefinitions.map((stage): StageDefinition => Object.freeze({
    ...stage,
    questions: Object.freeze(questions.get(stage.id) ?? []),
  })));
  return Object.freeze({
    schemaVersion: QUESTIONNAIRE_SCHEMA,
    packId: envelope.packId,
    packVersion: envelope.packVersion,
    title: string(metadata.title, "PACK_METADATA_REFUSED", 256),
    industry: string(metadata.industry, "PACK_METADATA_REFUSED", 128),
    archiveDigest: `sha256:${envelope.archiveSha256}`,
    releaseDigest: sha256(canonicalJson({ payload: releasePayload(envelope), signature: envelope.signature })),
    admittedAt,
    stages,
  });
}

export function admitIndustryPack(
  envelopeValue: unknown,
  archive: Uint8Array,
  registry: IndustryPackTrustRegistry,
  nowEpoch: number,
): AdmittedIndustryPack {
  const envelope = parseReleaseEnvelope(envelopeValue);
  verifyRelease(envelope, archive, registry, nowEpoch);
  return projection(readBoundedTarGzip(archive), envelope, new Date(nowEpoch * 1000).toISOString().replace(".000Z", "Z"));
}

export class AdmittedIndustryPackRegistry {
  private readonly packs = new Map<string, AdmittedIndustryPack>();

  admit(pack: AdmittedIndustryPack): void {
    const key = `${pack.packId}@${pack.packVersion}`;
    const current = this.packs.get(key);
    if (current && current.releaseDigest !== pack.releaseDigest) throw new ControlError("PACK_RELEASE_CONFLICT", 409);
    this.packs.set(key, pack);
  }

  list(): readonly AdmittedIndustryPack[] {
    return Object.freeze([...this.packs.values()].sort((left, right) => `${left.packId}@${left.packVersion}`.localeCompare(`${right.packId}@${right.packVersion}`)));
  }

  require(packId: string, packVersion: string): AdmittedIndustryPack {
    const pack = this.packs.get(`${packId}@${packVersion}`);
    if (!pack) throw new ControlError("QUESTIONNAIRE_PACK_NOT_FOUND", 404);
    return pack;
  }
}
