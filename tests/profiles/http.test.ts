import { describe, expect, it } from "vitest";

import type { TenantContext } from "../../apps/control-web/src/lib/foundation/contracts";
import { getBundle, getProfile, getProfileExplanation, lockProfile as lockProfileHttp, recordProfileApprovalDecision, requestBundle as requestBundleHttp, requestProfileApproval } from "../../apps/control-web/src/lib/profiles/http";
import type { ProfileRuntime } from "../../apps/control-web/src/lib/profiles/runtime";
import type { RequestAuthenticator } from "../../apps/control-web/src/lib/questionnaire/runtime";
import { NOW, PROFILE_ID, REVIEWER_ONE, REVIEWER_TWO, context, system } from "./fixture";

class FixtureAuthenticator implements RequestAuthenticator {
  constructor(private readonly tenant: TenantContext) {}
  authenticate(_request: Request, _mutation: boolean, _nowEpoch: number): TenantContext { return this.tenant; }
}

function runtime(tenant = context()): ProfileRuntime {
  return { store: system().store, authenticator: new FixtureAuthenticator(tenant), nowEpoch: () => NOW };
}

function mutation(url: string, body: string, etag: string, key: string): Request {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, "if-match": etag, "x-csrf-token": "c".repeat(32) }, body });
}

describe("CTRL-005 profile HTTP surface", () => {
  it("returns the tenant projection and exact markdown with no-store and nosniff", async () => {
    const fixture = runtime();
    const profile = await getProfile(new Request(`https://control.local/api/v1alpha1/profiles/${PROFILE_ID}`), fixture, PROFILE_ID);
    expect(profile.status).toBe(200);
    expect(profile.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/u);
    const explanation = await getProfileExplanation(new Request(`https://control.local/api/v1alpha1/profiles/${PROFILE_ID}/explanation`), fixture, PROFILE_ID);
    expect(explanation.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(explanation.headers.get("cache-control")).toBe("no-store");
    expect(explanation.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await explanation.text()).toContain("Enterprise target");
  });

  it("drives approval, lock, bundle request, and bundle read through closed routes", async () => {
    const fixture = runtime();
    let profileResponse = await getProfile(new Request("https://control.local"), fixture, PROFILE_ID);
    const approvalResponse = await requestProfileApproval(mutation("https://control.local/api/v1alpha1/profiles/x/approve", "{}", profileResponse.headers.get("etag") ?? "", "http-approval-request-001"), fixture, PROFILE_ID);
    expect(approvalResponse.status).toBe(202);
    let approvalEtag = approvalResponse.headers.get("etag") ?? "";
    const decisionBody = JSON.stringify({ decision: "APPROVE", reasonCode: "REVIEW_COMPLETE" });
    let decision = await recordProfileApprovalDecision(mutation("https://control.local/api/v1alpha1/profiles/x/approval/decision", decisionBody, approvalEtag, "http-reviewer-one-001"), { ...fixture, authenticator: new FixtureAuthenticator(context(REVIEWER_ONE)) }, PROFILE_ID);
    approvalEtag = decision.headers.get("etag") ?? "";
    decision = await recordProfileApprovalDecision(mutation("https://control.local/api/v1alpha1/profiles/x/approval/decision", decisionBody, approvalEtag, "http-reviewer-two-001"), { ...fixture, authenticator: new FixtureAuthenticator(context(REVIEWER_TWO)) }, PROFILE_ID);
    expect((await decision.json() as { state: string }).state).toBe("APPROVED");
    profileResponse = await getProfile(new Request("https://control.local"), fixture, PROFILE_ID);
    const locked = await lockProfileHttp(mutation("https://control.local/api/v1alpha1/profiles/x/lock", "{}", profileResponse.headers.get("etag") ?? "", "http-profile-lock-001"), fixture, PROFILE_ID);
    expect(locked.status).toBe(201);
    profileResponse = await getProfile(new Request("https://control.local"), fixture, PROFILE_ID);
    const bundle = await requestBundleHttp(mutation("https://control.local/api/v1alpha1/bundles", JSON.stringify({ profileId: PROFILE_ID }), profileResponse.headers.get("etag") ?? "", "http-bundle-request-001"), fixture);
    expect(bundle.status).toBe(202);
    expect(bundle.headers.get("location")).toMatch(/^\/api\/v1alpha1\/bundles\/bundle-request\./u);
    const bundleId = (await bundle.json() as { id: string }).id;
    expect((await (await getBundle(new Request("https://control.local"), fixture, bundleId)).json() as { state: string }).state).toBe("REQUESTED");
  });

  it("rejects duplicate JSON members and caller-supplied tenant identity", async () => {
    const fixture = runtime();
    const profile = await getProfile(new Request("https://control.local"), fixture, PROFILE_ID);
    const duplicate = await requestBundleHttp(mutation("https://control.local/api/v1alpha1/bundles", `{"profileId":"${PROFILE_ID}","profileId":"${PROFILE_ID}"}`, profile.headers.get("etag") ?? "", "http-duplicate-body-001"), fixture);
    expect(duplicate.status).toBe(400);
    const leaked = await getProfile(new Request(`https://control.local?organizationId=${context().organizationId}`), fixture, PROFILE_ID);
    expect(leaked.status).toBe(400);
  });
});
