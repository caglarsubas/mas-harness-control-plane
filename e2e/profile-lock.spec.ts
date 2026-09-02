import { describe, expect, it } from "vitest";

import { PROFILE_ID, SOURCE_ID, context, requestBundle, signedEnvelope, system } from "../tests/profiles/fixture";

describe("CTRL-005 end-to-end profile lock and bundle handoff", () => {
  it("preserves separate profile, operation, signature-source, and later evidence states", () => {
    const { store } = system();
    const requested = requestBundle(store);
    const locked = store.readProfile(context(), PROFILE_ID);
    expect(locked.body.state).toBe("LOCKED");
    expect(locked.body.bundle?.state).toBe("REQUESTED");
    expect(requested.body.operation.spec.state).toBe("PENDING");

    const accepted = store.reportSignedBundle(SOURCE_ID, signedEnvelope(requested.body.id, locked.body.reviewDigest), 1_780_272_060);
    expect(accepted.body.state).toBe("SOURCE_REPORTED_SIGNED");
    expect(accepted.body.operation.spec.state).toBe("SUCCEEDED");

    const projected = store.readProfile(context(), PROFILE_ID).body;
    expect(projected.evidenceAxes).toEqual({
      source: "PASS",
      contractUnit: "PASS",
      artifactSbom: "MISSING",
      signatureRelease: "SOURCE_REPORTED_ONLY",
      deployment: "NOT_RUN_ENV_UNAVAILABLE",
      runtime: "NOT_RUN_ENV_UNAVAILABLE",
      security: "NOT_RUN_ENV_UNAVAILABLE",
      assurance: "MISSING",
      tenantAcceptance: "MISSING",
    });
  });
});
