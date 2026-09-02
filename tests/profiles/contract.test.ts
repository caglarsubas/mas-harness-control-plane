import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../apps/control-web/src/lib/foundation/canonical";
import { COMPILER_AUTHORITY } from "../../apps/control-web/src/lib/operations/contracts";
import { PROFILE_CONTRACT_AUTHORITY } from "../../apps/control-web/src/lib/profiles/contracts";
import { ProfileLifecycleStore, profileMutationFingerprint } from "../../apps/control-web/src/lib/profiles/service";
import { InMemoryProfileApprovalPolicy } from "../../apps/control-web/src/lib/profiles/dependencies";
import { OperationStore } from "../../apps/control-web/src/lib/operations/service";
import { PROFILE_ID, NOW, compiledOutputs, context, profilePolicy, system } from "./fixture";

describe("CTRL-005 exact profile contract", () => {
  it("pins the accepted compiler and lifecycle authorities", () => {
    expect(COMPILER_AUTHORITY.repository).toBe("caglarsubas/mas-harness-contracts");
    expect(COMPILER_AUTHORITY.commit).toBe("2146278a95344cd2a8e22596b2f315b46edffc88");
    expect(COMPILER_AUTHORITY.operationSchemaSha256).toBe("876bd985adf2267e5f4594e19e3e37296eab8cad7344c2d23cb68ca2c97a4982");
    expect(COMPILER_AUTHORITY.cloudEventSchemaSha256).toBe("4e1282bda0b3f947265a84545ed5b2fdea0a1bb4e69af3642fc14c265811c56c");
    expect(COMPILER_AUTHORITY.lifecycleTransitionsSha256).toBe("17122d47f3d3cce568f117b9113f83821db3aaddba3c910afb40e068f193dffc");
    expect(PROFILE_CONTRACT_AUTHORITY).toMatchObject({
      commit: "2146278a95344cd2a8e22596b2f315b46edffc88",
      harnessProfileSchemaSha256: "08936914f52b8c3b611e47ffa35f668dd177718f613907687a67b448877c39a6",
      compiledProfileDocumentSchemaSha256: "2b3b3d70a7fe00ca5667634622b0fafa22562f0a33f363663e27757aaa57bfcb",
      approvalRequestSchemaSha256: "4fe8d214a920690008a4390919acebf797b0ab4e6c649a7a88e0882f3b2a1b27",
      bundleReleaseSchemaSha256: "c983a8d97c70d7957e74f06413ca0158e3b7be626468bf8d217dfc5829aa5918",
    });
  });

  it("projects named harnesses, modules, providers, six output digests, and honest evidence axes", () => {
    const { store } = system();
    const profile = store.readProfile(context(), PROFILE_ID).body;
    expect(Object.keys(profile.outputDigests).sort()).toEqual([
      "bom.json", "evidence-plan.json", "explanation.md", "install-plan.json", "profile.json", "profile.sha256",
    ]);
    expect((profile.profile.spec as Record<string, unknown>).selectedHarnessIds).toEqual([
      "knowledge.domain-semantic", "knowledge.data-integration",
    ]);
    expect((profile.profile.spec as Record<string, unknown>).selectedProviderIds).toEqual(["provider.runtime.infrastructure.local"]);
    expect(profile.evidenceAxes).toMatchObject({
      source: "PASS", contractUnit: "PASS", artifactSbom: "MISSING", signatureRelease: "MISSING",
      deployment: "NOT_RUN_ENV_UNAVAILABLE", runtime: "NOT_RUN_ENV_UNAVAILABLE", tenantAcceptance: "MISSING",
    });
    expect(Buffer.from(store.explanation(context(), PROFILE_ID)).toString("utf8")).toContain("Two named knowledge harnesses");
  });

  it.each(["profile.json", "bom.json", "install-plan.json", "evidence-plan.json", "explanation.md", "profile.sha256"] as const)(
    "fails closed when %s changes",
    (name) => {
      const { store } = system();
      store.tamperOutputForTest(context().organizationId, PROFILE_ID, name, Buffer.from("tampered\n"));
      expect(() => store.readProfile(context(), PROFILE_ID)).toThrowError("PROFILE_REVISION_TAMPERED");
    },
  );

  it("blocks unresolved selector proposals before policy admission", () => {
    const { store } = system([{ selectorGroup: "group.model-backend" }]);
    const current = store.readProfile(context(), PROFILE_ID);
    expect(() => store.requestApproval(
      context(), PROFILE_ID, current.etag, "unresolved-selector-001",
      profileMutationFingerprint("POST", `/api/v1alpha1/profiles/${PROFILE_ID}/approve`, {}), NOW,
    )).toThrowError("PROFILE_SELECTORS_UNRESOLVED");
  });

  it("rejects a registration whose profile checksum is not the exact profile bytes", () => {
    const outputs = { ...compiledOutputs(), "profile.sha256": Buffer.from(`sha256:${"0".repeat(64)}\n`) };
    const outputDigests = Object.freeze(Object.fromEntries(Object.entries(outputs).map(([name, value]) => [name, sha256(value)])));
    const demandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const demandDigest = `sha256:${"d".repeat(64)}`;
    const compilerWheelDigest = `sha256:${"5".repeat(64)}`;
    const catalogDigest = `sha256:${"c".repeat(64)}`;
    const operations = new OperationStore({ readDemand() { throw new Error("unused"); } }, { resolve() { return { availability: "UNAVAILABLE" }; } });
    const store = new ProfileLifecycleStore(new InMemoryProfileApprovalPolicy(profilePolicy()), operations);
    expect(() => store.registerCompiledProfile({
      organizationId: context().organizationId,
      profileId: PROFILE_ID,
      profileRevision: 1,
      resultKey: sha256(canonicalJson({ binding: [context().organizationId, demandId, 7, demandDigest, compilerWheelDigest, catalogDigest], profileDigest: outputDigests["profile.json"] })),
      demandId,
      demandRevision: 7,
      demandDigest,
      compilerWheelDigest,
      catalogDigest,
      outputs,
      outputDigests: outputDigests as Readonly<Record<keyof typeof outputs, string>>,
      createdAt: "2026-05-29T00:00:00Z",
    })).toThrowError("PROFILE_REVISION_TAMPERED");
  });
});
