export const STATUS_API_VERSION = "harness.planeon.ai/v1alpha1" as const;
export const PROJECTION_SCHEMA_VERSION = "harness.planeon.ai/status-projection/v1alpha1" as const;

export const SELECTION_STATES = ["NOT_SELECTED", "PROPOSED", "SELECTED", "BLOCKED"] as const;
export const INSTALLATION_STATES = [
  "ABSENT", "PENDING", "PREFLIGHT", "VERIFYING", "APPLYING", "HEALTH_CHECKING",
  "READY", "BLOCKED", "DEGRADED", "FAILED", "UPGRADING", "ROLLING_BACK",
  "UNINSTALLING", "REMOVED", "RETIRED", "REVOKED",
] as const;
export const EVIDENCE_STATES = [
  "NOT_APPLICABLE", "MISSING", "COLLECTING", "PASS", "WARN", "FAIL", "STALE",
  "WAIVED", "NOT_RUN_ENV_UNAVAILABLE",
] as const;
export const EVIDENCE_AXES = [
  "SOURCE", "CONTRACT_UNIT", "PR_CHECK", "MERGE", "ARTIFACT_SBOM",
  "SIGNATURE_RELEASE", "DEPLOYMENT", "RUNTIME", "SECURITY", "ASSURANCE",
  "TENANT_ACCEPTANCE",
] as const;
export const FRESHNESS_STATES = ["CURRENT", "STALE", "SOURCE_UNAVAILABLE"] as const;
export const AGGREGATE_STATES = ["EMPTY", "READY", "DEGRADED", "BLOCKED", "FAILED", "REVOKED"] as const;
export const SOURCE_IDS = [
  "PROFILE_LOCK", "DISTRIBUTION_RELEASE", "OPERATOR_RECONCILIATION", "TRUST_EVIDENCE",
  "RUNTIME_HEALTH", "SECURITY_ASSURANCE", "ASSURANCE_CAMPAIGN", "TENANT_ACCEPTANCE",
] as const;

export type SelectionState = typeof SELECTION_STATES[number];
export type InstallationState = typeof INSTALLATION_STATES[number];
export type EvidenceState = typeof EVIDENCE_STATES[number];
export type EvidenceAxis = typeof EVIDENCE_AXES[number];
export type FreshnessState = typeof FRESHNESS_STATES[number];
export type AggregateState = typeof AGGREGATE_STATES[number];
export type SourceId = typeof SOURCE_IDS[number];
export type PlaneId = "runtime" | "knowledge" | "execution" | "trust";
export type DeploymentMode = "operator-hosted-saas" | "tenant-public-cloud" | "self-managed" | "air-gapped";
export type IsolationBoundary = "SHARED_RLS" | "DEDICATED_NAMESPACE" | "DEDICATED_CLUSTER" | "PHYSICAL_AIR_GAP";
export type PermittedAction = "REQUEST_EVIDENCE" | "REFRESH_PROJECTION" | "REVIEW_WAIVER" | "RETRY_OPERATION" | "ROLLBACK" | "RESOLVE_DEPENDENCY" | "CONTACT_OWNER" | "NONE";

export function sourceCursorId(sourceId: SourceId): string {
  return `source.${sourceId.toLowerCase().replaceAll("_", "-")}`;
}

export interface SourceCursor {
  readonly sourceId: string;
  readonly cursor: string;
  readonly observedAt: string;
  readonly state: "CURRENT" | "SOURCE_UNAVAILABLE";
}

export interface ProjectionBinding {
  readonly organizationId: string;
  readonly profileDigest: string;
  readonly bundleDigest: string;
  readonly releaseDigest: string;
  readonly observedGeneration: number;
  readonly projectedAt: string;
  readonly freshUntil: string;
  readonly sourceCursors: readonly SourceCursor[];
  readonly projectionSchemaVersion: typeof PROJECTION_SCHEMA_VERSION;
}

export interface ProjectionFreshness {
  readonly state: FreshnessState;
  readonly projectedAt: string;
  readonly freshUntil: string;
  readonly sourceCursors: readonly SourceCursor[];
}

export interface EvidenceRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly id: string;
  readonly digest: string;
}

export interface StatusAxisProjection {
  readonly axis: EvidenceAxis;
  readonly required: boolean;
  readonly state: EvidenceState;
  readonly underlyingState: Exclude<EvidenceState, "WAIVED"> | null;
  readonly observedAt: string | null;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly waiver: null | {
    readonly waiverId: string;
    readonly waiverDigest: string;
    readonly approvedBy: string;
    readonly expiresAt: string;
    readonly basisCode: string;
  };
  readonly applicability: null | { readonly reasonCode: string; readonly contractRef: EvidenceRef };
}

export interface StatusFindingSummary {
  readonly findingId: string;
  readonly severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  readonly reasonCode: string;
  readonly affectedAxis: EvidenceAxis | null;
  readonly ownerRef: string;
  readonly blocking: boolean;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly permittedActions: readonly PermittedAction[];
}

export interface HarnessSummary {
  readonly harnessId: string;
  readonly planeId: PlaneId;
  readonly selectionState: SelectionState;
  readonly installationState: InstallationState;
  readonly aggregateState: AggregateState;
  readonly highestEvidenceState: EvidenceState;
  readonly freshnessState: FreshnessState;
  readonly blockerCount: number;
  readonly reasonCode: string;
}

export interface HarnessStatusProjection {
  readonly apiVersion: typeof STATUS_API_VERSION;
  readonly kind: "HarnessStatusProjection";
  readonly binding: ProjectionBinding;
  readonly spec: {
    readonly harnessId: string;
    readonly planeId: PlaneId;
    readonly purposeCode: string;
    readonly ownerRef: string;
    readonly selectionState: SelectionState;
    readonly installationState: InstallationState;
    readonly aggregateState: AggregateState;
    readonly desiredGeneration: number;
    readonly observedGeneration: number;
    readonly currentReleaseDigest: string | null;
    readonly lastGoodReleaseDigest: string | null;
    readonly selectedModuleIds: readonly string[];
    readonly selectedProviderIds: readonly string[];
    readonly axes: readonly StatusAxisProjection[];
    readonly freshness: ProjectionFreshness;
    readonly dependencies: readonly {
      readonly harnessId: string;
      readonly requirement: "REQUIRED" | "OPTIONAL" | "PRODUCTION_GATE";
      readonly state: AggregateState;
      readonly blocking: boolean;
      readonly reasonCode: string;
    }[];
    readonly findings: readonly StatusFindingSummary[];
    readonly reasonCode: string;
    readonly permittedActions: readonly PermittedAction[];
  };
}

export interface PlaneSummary {
  readonly planeId: PlaneId;
  readonly aggregateState: AggregateState;
  readonly selectedCount: number;
  readonly notSelectedCount: number;
  readonly worstInstallationState: InstallationState | null;
  readonly freshnessState: FreshnessState;
  readonly blockingDependencyCount: number;
  readonly harnesses: readonly HarnessSummary[];
}

export interface PlaneStatusProjection {
  readonly apiVersion: typeof STATUS_API_VERSION;
  readonly kind: "PlaneStatusProjection";
  readonly binding: ProjectionBinding;
  readonly spec: PlaneSummary & {
    readonly evidenceCounts: readonly { readonly state: string; readonly count: number }[];
    readonly freshness: ProjectionFreshness;
    readonly reasonCode: string;
  };
}

export interface TenantHarnessOverview {
  readonly apiVersion: typeof STATUS_API_VERSION;
  readonly kind: "TenantHarnessOverview";
  readonly binding: ProjectionBinding | null;
  readonly spec: {
    readonly organizationId: string;
    readonly displayName: string;
    readonly deploymentMode: DeploymentMode;
    readonly isolationBoundary: IsolationBoundary;
    readonly empty: boolean;
    readonly aggregateState: AggregateState;
    readonly freshness: ProjectionFreshness | null;
    readonly stateCounts: readonly { readonly state: string; readonly count: number }[];
    readonly priorityFindings: readonly StatusFindingSummary[];
    readonly planes: readonly PlaneSummary[];
    readonly harnesses: readonly HarnessSummary[];
  };
}

export interface OrganizationPortfolioPage {
  readonly apiVersion: typeof STATUS_API_VERSION;
  readonly kind: "OrganizationHarnessPortfolioPage";
  readonly spec: {
    readonly scope: "PLATFORM_OPERATOR";
    readonly projectionSchemaVersion: typeof PROJECTION_SCHEMA_VERSION;
    readonly limit: number;
    readonly nextCursor: string | null;
    readonly items: readonly {
      readonly binding: ProjectionBinding;
      readonly displayName: string;
      readonly deploymentMode: DeploymentMode;
      readonly aggregateState: AggregateState;
      readonly freshnessState: FreshnessState;
      readonly selectedCount: number;
      readonly blockerCount: number;
    }[];
  };
}

export interface SourceSummary {
  readonly sourceId: SourceId;
  readonly sourcePrincipalDigest: string;
  readonly sourceAdmissionDigest: string;
  readonly eventId: string;
  readonly organizationId: string;
  readonly sequence: number;
  readonly cursor: string;
  readonly observedAt: string;
  readonly profileDigest: string;
  readonly bundleDigest: string;
  readonly releaseDigest: string;
  readonly observedGeneration: number;
  readonly contentDigest: string;
  readonly overview: TenantHarnessOverview;
  readonly planes: readonly PlaneStatusProjection[];
  readonly harnesses: readonly HarnessStatusProjection[];
}
