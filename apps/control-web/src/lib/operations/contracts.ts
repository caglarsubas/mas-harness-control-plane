import type { DemandProjection, ResourceRef } from "../demands/contracts";

export const OPERATION_SCHEMA = "planeon.control.operation/v1alpha1" as const;
export const HARNESS_API_VERSION = "harness.planeon.ai/v1alpha1" as const;

export const COMPILER_AUTHORITY = Object.freeze({
  repository: "caglarsubas/mas-harness-contracts",
  commit: "2146278a95344cd2a8e22596b2f315b46edffc88",
  releaseManifestSha256: "c5dd4c39d1c69d07f8d8de3d1a09584bb906172fee2d5ac20ad25ff344b0db79",
  compilerWheelSha256: "53500a690c8b7614e0cb6ea1e4d78e0831b94a458523e558fedfeb13428bb97b",
  compileRequestSchemaSha256: "559951b883d9762a8f47db0d3e4bc7fbb4ec22dca0b2a2de9a677ff2d668bfcb",
  operationSchemaSha256: "876bd985adf2267e5f4594e19e3e37296eab8cad7344c2d23cb68ca2c97a4982",
  cloudEventSchemaSha256: "4e1282bda0b3f947265a84545ed5b2fdea0a1bb4e69af3642fc14c265811c56c",
  lifecycleTransitionsSha256: "17122d47f3d3cce568f117b9113f83821db3aaddba3c910afb40e068f193dffc",
});

export type OperationState = "PENDING" | "RUNNING" | "CANCELLING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface OperationFailure {
  readonly reasonCode: string;
  readonly retryable: boolean;
  readonly evidenceRefs: readonly ResourceRef[];
}

export interface OperationResource {
  readonly apiVersion: typeof HARNESS_API_VERSION;
  readonly kind: "Operation";
  readonly metadata: {
    readonly id: string;
    readonly version: string;
  };
  readonly spec: {
    readonly organizationId: string;
    readonly operationType: "COMPILE_PROFILE";
    readonly state: OperationState;
    readonly subject: ResourceRef;
    readonly actor: {
      readonly type: "HUMAN";
      readonly id: string;
    };
    readonly idempotencyKeyDigest: string;
    readonly requestedAt: string;
    readonly updatedAt: string;
    readonly observedVersion: number;
    readonly cancellable: false;
    readonly resultRefs: readonly ResourceRef[];
    readonly failure: OperationFailure | null;
  };
}

export interface ResolvedCompileInput {
  readonly organizationId: string;
  readonly demandId: string;
  readonly demandRevision: number;
  readonly demandDigest: string;
  readonly questionnaireAnswerSetId: string;
  readonly questionnaireAnswerSetDigest: string;
  readonly readinessAssessmentId: string;
  readonly readinessAssessmentDigest: string;
  readonly environmentAttestationDigest: string;
  readonly compileRequest: Readonly<Record<string, unknown>>;
  readonly catalogResources: readonly Readonly<Record<string, unknown>>[];
  readonly catalogDigest: string;
  readonly inputDigest: string;
}

export type CompileInputResolution =
  | { readonly availability: "AVAILABLE"; readonly input: ResolvedCompileInput }
  | { readonly availability: "NOT_FOUND" }
  | { readonly availability: "UNAVAILABLE" };

export interface CompileInputResolver {
  resolve(organizationId: string, demand: DemandProjection): CompileInputResolution;
}

export interface DemandReader {
  readDemand(
    context: import("../foundation/contracts").TenantContext,
    id: string,
  ): { readonly status: number; readonly body: DemandProjection; readonly etag: string };
}

export interface QueuedCompilationJob {
  readonly schemaVersion: typeof OPERATION_SCHEMA;
  readonly id: string;
  readonly organizationId: string;
  readonly operationId: string;
  readonly state: "QUEUED";
  readonly demandId: string;
  readonly demandRevision: number;
  readonly demandDigest: string;
  readonly inputDigest: string;
  readonly catalogDigest: string;
  readonly compilerWheelDigest: string;
  readonly compileRequest: Readonly<Record<string, unknown>>;
  readonly catalogResources: readonly Readonly<Record<string, unknown>>[];
  readonly attempt: 0;
  readonly availableAt: string;
  readonly createdAt: string;
}

export interface OperationAuditEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateDigest: string;
  readonly actorDigest: string;
  readonly occurredAt: string;
}

export interface HarnessOperationEvent {
  readonly specversion: "1.0";
  readonly id: string;
  readonly source: "urn:planeon:harness:control.profile-compiler";
  readonly type: "harness.operation.state.changed.v1";
  readonly subject: string;
  readonly time: string;
  readonly datacontenttype: "application/json";
  readonly dataschema: "https://harness.planeon.ai/schemas/v1alpha1/events/harness-cloud-event.schema.json";
  readonly organizationid: string;
  readonly partitionkey: string;
  readonly sequence: number;
  readonly data: {
    readonly schemaVersion: "harness.planeon.ai/event-data/v1alpha1";
    readonly aggregateKind: "Operation";
    readonly aggregateId: string;
    readonly aggregateVersion: number;
    readonly actor: { readonly type: "WORKLOAD"; readonly id: "worker.profile-compiler" };
    readonly correlationId: string;
    readonly causationId: string | null;
    readonly reasonCode: string;
    readonly transition: { readonly from: OperationState; readonly to: OperationState };
    readonly resourceRefs: readonly ResourceRef[];
    readonly evidenceRefs: readonly [];
  };
}
