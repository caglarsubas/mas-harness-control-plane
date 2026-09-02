import type {
  ApprovalPolicyHook,
  ApprovalPolicyResult,
  DemandSourceReference,
  DemandSourceResolution,
  DemandSourceResolver,
  PolicyAdmissionRequest,
  ResolvedDemandSource,
} from "./contracts";

export class InMemoryDemandSourceResolver implements DemandSourceResolver {
  private readonly sources = new Map<string, ResolvedDemandSource>();
  private unavailable = false;

  register(source: ResolvedDemandSource): void {
    this.sources.set(`${source.organizationId}:${source.questionnaireSessionId}`, Object.freeze({ ...source }));
  }

  setUnavailableForTest(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  resolve(organizationId: string, reference: DemandSourceReference): DemandSourceResolution {
    if (this.unavailable) return Object.freeze({ availability: "UNAVAILABLE" });
    const source = this.sources.get(`${organizationId}:${reference.questionnaireSessionId}`);
    return source
      ? Object.freeze({ availability: "AVAILABLE", source })
      : Object.freeze({ availability: "NOT_FOUND" });
  }
}

export class FixedApprovalPolicyHook implements ApprovalPolicyHook {
  private readonly results = new Map<string, ApprovalPolicyResult>();
  private fallback: ApprovalPolicyResult = Object.freeze({ disposition: "UNAVAILABLE" });

  set(organizationId: string, result: ApprovalPolicyResult): void {
    this.results.set(organizationId, Object.freeze(result));
  }

  setFallback(result: ApprovalPolicyResult): void {
    this.fallback = Object.freeze(result);
  }

  evaluate(request: PolicyAdmissionRequest): ApprovalPolicyResult {
    return this.results.get(request.organizationId) ?? this.fallback;
  }
}
