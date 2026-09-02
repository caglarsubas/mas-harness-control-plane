export const QUESTIONNAIRE_SCHEMA = "planeon.control.questionnaire/v1alpha1" as const;
export const INDUSTRY_PACK_PURPOSE = "INDUSTRY_PACK_RELEASE" as const;

export const CONTRACT_AUTHORITY = Object.freeze({
  repository: "caglarsubas/mas-harness-contracts",
  commit: "2146278a95344cd2a8e22596b2f315b46edffc88",
  catalogDigest: "sha256:26d442c4e90a19d767d32e80ef9df3d154b3146d3238dc0eecf29ee773913a26",
  releaseManifestSha256: "c5dd4c39d1c69d07f8d8de3d1a09584bb906172fee2d5ac20ad25ff344b0db79",
  questionnaireDefinitionSha256: "c8857968da611838f4bd623c7727cd3c90619f12fc7cfed0db96effacac47223",
  questionnaireSessionSha256: "c7bcc030bd5cc19f03433f5fe7e08e41c2d91be40e4e94d312a64bac1794f17a",
  questionnaireAnswerSetSha256: "cceebb735554d91f82395032f3ddcf475fc05ea897dfdff36165bcd71edaf828",
});

export const WHITE_GOODS_PROVENANCE = Object.freeze({
  repository: "caglarsubas/mas-harness-industry-packs",
  commit: "c6513d71535d56c71869bf889169d798c7b80c9c",
  packId: "white-goods.manufacturing",
  packVersion: "0.5.0",
  packYamlSha256: "c78f6f284513a605d10e67413291b209fa4d5b03e8510ef37f20cc95d38688ee",
  journeySha256: "950a6d21c68a35117a3cd36d67491cde85274ef911d78ff8585e1be8671db2fb",
  contractsLockSha256: "81d7470e28b452cbf8de2e4903b47b5335709b09cf6375f78481057973d75c91",
  packLockSha256: "c9d559c972b8b6f7515853e6545eb276567b4aeb860cb99a46c477cd840b80d2",
  packLockPayloadDigest: "3c3659a732e5c7ad2cdba6ca45e87f18790791097dce6b5cabe93d74f32e65fe",
  artifactManifestSha256: "00f89e371031b007ef4565dc1bc9cfccccf848714d30d967845aea0e3e62a949",
  acceptedPilotSha256: "b76421c1f0cfa258c97f159a48f0f8f53782ec6415384b9fed3acc57119da052",
  upstreamReleaseState: "NOT_RETAINED",
});

export const JOURNEY_STAGES = Object.freeze([
  { id: "business-context", title: "Business context" },
  { id: "domain-and-outcomes", title: "Domain and outcomes" },
  { id: "data-readiness", title: "Data readiness" },
  { id: "governance-and-regulation", title: "Governance and regulation" },
  { id: "integration-readiness", title: "Integration readiness" },
  { id: "harness-demand", title: "Harness demand" },
  { id: "environment-and-provider-fit", title: "Environment and provider fit" },
  { id: "evidence-and-acceptance", title: "Evidence and acceptance" },
] as const);

export type StageId = typeof JOURNEY_STAGES[number]["id"];
export type QuestionResponseType = "string" | "number" | "boolean" | "single-choice" | "multiple-choice";
export type QuestionnaireState = "DRAFT" | "IN_PROGRESS" | "BLOCKED" | "READY_FOR_COMPILATION" | "SUPERSEDED";
export type AnswerValue = string | number | boolean | readonly string[];

export interface IndustryPackReleasePayload {
  readonly purpose: typeof INDUSTRY_PACK_PURPOSE;
  readonly keyId: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly archiveSha256: string;
  readonly archiveSize: number;
  readonly packLockSha256: string;
  readonly artifactManifestSha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface IndustryPackReleaseEnvelope extends IndustryPackReleasePayload {
  readonly schemaVersion: "planeon.control.industry-pack-release-envelope/v1alpha1";
  readonly algorithm: "ED25519";
  readonly signature: string;
}

export interface IndustryPackTrustKey {
  readonly keyId: string;
  readonly algorithm: "ED25519";
  readonly purpose: typeof INDUSTRY_PACK_PURPOSE;
  readonly state: "ACTIVE" | "REVOKED";
  readonly notBefore: string;
  readonly notAfter: string;
  readonly publicKeyPem: string;
}

export interface IndustryPackTrustRegistry {
  readonly schemaVersion: "planeon.control.industry-pack-trust-registry/v1alpha1";
  readonly keys: readonly IndustryPackTrustKey[];
}

export interface QuestionDefinition {
  readonly id: string;
  readonly prompt: string;
  readonly responseType: QuestionResponseType;
  readonly required: boolean;
  readonly options: readonly string[];
}

export interface StageDefinition {
  readonly id: StageId;
  readonly title: string;
  readonly purpose: string;
  readonly questions: readonly QuestionDefinition[];
}

export interface AdmittedIndustryPack {
  readonly schemaVersion: typeof QUESTIONNAIRE_SCHEMA;
  readonly packId: string;
  readonly packVersion: string;
  readonly title: string;
  readonly industry: string;
  readonly archiveDigest: string;
  readonly releaseDigest: string;
  readonly admittedAt: string;
  readonly stages: readonly StageDefinition[];
}

export interface TenantAnswer {
  readonly questionId: string;
  readonly value: AnswerValue;
  readonly source: "TENANT_DECLARATION";
}

export interface AnswerRevision {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly revision: number;
  readonly stageId: StageId;
  readonly answers: readonly TenantAnswer[];
  readonly actorDigest: string;
  readonly occurredAt: string;
}

export interface ReadinessFinding {
  readonly findingId: string;
  readonly sessionId: string;
  readonly organizationId: string;
  readonly revision: number;
  readonly stageId: StageId;
  readonly questionId: string | null;
  readonly severity: "BLOCKING" | "PASS";
  readonly reasonCode: "MISSING_REQUIRED_ANSWER" | "QUESTIONNAIRE_COMPLETE";
  readonly occurredAt: string;
}

export interface QuestionnaireSessionProjection {
  readonly schemaVersion: typeof QUESTIONNAIRE_SCHEMA;
  readonly id: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly packDigest: string;
  readonly state: QuestionnaireState;
  readonly currentStageId: StageId;
  readonly completedStageIds: readonly StageId[];
  readonly revision: number;
  readonly answers: readonly TenantAnswer[];
  readonly findings: readonly ReadinessFinding[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuditEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly actorDigest: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateDigest: string;
  readonly occurredAt: string;
}

export interface StoredMutationResponse<T> {
  readonly status: number;
  readonly body: T;
  readonly etag: string;
}
