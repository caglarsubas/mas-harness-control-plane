import type {
  AdmittedProfilePolicy,
  ProfileApprovalPolicyHook,
  ProfilePolicyAdmissionRequest,
  ProfilePolicyResult,
} from "./contracts";

export class InMemoryProfileApprovalPolicy implements ProfileApprovalPolicyHook {
  constructor(private readonly policy: AdmittedProfilePolicy) {}

  evaluate(_request: ProfilePolicyAdmissionRequest): ProfilePolicyResult {
    return Object.freeze({
      ...this.policy,
      policyRef: Object.freeze({ ...this.policy.policyRef }),
      eligibleReviewerDigests: Object.freeze([...this.policy.eligibleReviewerDigests]),
    });
  }
}

export class UnavailableProfileApprovalPolicy implements ProfileApprovalPolicyHook {
  evaluate(_request: ProfilePolicyAdmissionRequest): ProfilePolicyResult {
    return Object.freeze({ disposition: "UNAVAILABLE" });
  }
}
