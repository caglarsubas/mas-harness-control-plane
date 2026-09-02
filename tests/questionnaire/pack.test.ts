import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ControlError } from "../../apps/control-web/src/lib/foundation/contracts";
import {
  CONTRACT_AUTHORITY,
  JOURNEY_STAGES,
  WHITE_GOODS_PROVENANCE,
} from "../../apps/control-web/src/lib/questionnaire/contracts";
import {
  admitIndustryPack,
  loadIndustryPackTrustRegistry,
  parseTrustRegistry,
} from "../../apps/control-web/src/lib/questionnaire/pack";
import { buildSignedPackFixture } from "./fixture";

const NOW = Date.parse("2026-06-01T00:00:00Z") / 1000;

function code(action: () => unknown): string {
  try {
    action();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof ControlError ? error.code : "UNEXPECTED_ERROR";
  }
}

describe("signed local industry-pack admission", () => {
  it("admits one bounded Ed25519 release and preserves the eight immutable stages", () => {
    const fixture = buildSignedPackFixture();
    const pack = admitIndustryPack(fixture.envelope, fixture.archive, fixture.registry, NOW);
    expect(pack.packId).toBe("white-goods.synthetic");
    expect(pack.packVersion).toBe("0.5.0");
    expect(pack.stages.map((stage) => stage.id)).toEqual(JOURNEY_STAGES.map((stage) => stage.id));
    expect(pack.stages.flatMap((stage) => stage.questions)).toHaveLength(8);
    expect(pack.archiveDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.stages)).toBe(true);
  });

  it("pins the contracts release and unsigned white-goods provenance independently", () => {
    expect(CONTRACT_AUTHORITY.commit).toBe("2146278a95344cd2a8e22596b2f315b46edffc88");
    expect(CONTRACT_AUTHORITY.questionnaireDefinitionSha256).toBe("c8857968da611838f4bd623c7727cd3c90619f12fc7cfed0db96effacac47223");
    expect(CONTRACT_AUTHORITY.questionnaireSessionSha256).toBe("c7bcc030bd5cc19f03433f5fe7e08e41c2d91be40e4e94d312a64bac1794f17a");
    expect(CONTRACT_AUTHORITY.questionnaireAnswerSetSha256).toBe("cceebb735554d91f82395032f3ddcf475fc05ea897dfdff36165bcd71edaf828");
    expect(WHITE_GOODS_PROVENANCE.commit).toBe("c6513d71535d56c71869bf889169d798c7b80c9c");
    expect(WHITE_GOODS_PROVENANCE.upstreamReleaseState).toBe("NOT_RETAINED");
  });

  it.each([
    ["signature", { signatureTampered: true }, "PACK_SIGNATURE_REFUSED"],
    ["revoked key", { trustState: "REVOKED" as const }, "PACK_RELEASE_KEY_REVOKED"],
    ["wrong purpose", { wrongPurpose: true }, "PACK_RELEASE_PURPOSE_REFUSED"],
    ["unsigned upstream state", { manifestState: "NOT_RETAINED" as const }, "PACK_MANIFEST_RELEASE_REFUSED"],
    ["lock payload", { lockPayloadTampered: true }, "PACK_LOCK_PAYLOAD_REFUSED"],
    ["index binding", { indexTampered: true }, "PACK_INDEX_BINDING_REFUSED"],
    ["unsafe tar path", { unsafePath: true }, "PACK_ARCHIVE_PATH_REFUSED"],
  ])("rejects %s", (_name, options, expected) => {
    const fixture = buildSignedPackFixture(options);
    expect(code(() => admitIndustryPack(fixture.envelope, fixture.archive, fixture.registry, NOW))).toBe(expected);
  });

  it("rejects unknown, expired, and archive-tampered authorities", () => {
    const unknown = buildSignedPackFixture();
    expect(code(() => admitIndustryPack({ ...unknown.envelope, keyId: "unknown-release-key" }, unknown.archive, unknown.registry, NOW))).toBe("PACK_RELEASE_KEY_UNKNOWN");

    const expired = buildSignedPackFixture();
    expect(code(() => admitIndustryPack(expired.envelope, expired.archive, expired.registry, Date.parse("2028-01-01T00:00:00Z") / 1000))).toBe("PACK_RELEASE_TIME_REFUSED");

    const tampered = buildSignedPackFixture();
    const bytes = Uint8Array.from(tampered.archive);
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    expect(code(() => admitIndustryPack(tampered.envelope, bytes, tampered.registry, NOW))).toBe("PACK_ARCHIVE_BINDING_REFUSED");
  });

  it.each([
    ["duplicate key", `apiVersion: harness.planeon.ai/questionnaire/v1alpha1\nkind: Questionnaire\nid: synthetic.business-context\nid: duplicate\nstage: business-context\ntitle: Duplicate key\nquestions: []\n`],
    ["alias", `apiVersion: harness.planeon.ai/questionnaire/v1alpha1\nkind: Questionnaire\nid: synthetic.business-context\nstage: business-context\ntitle: Alias refused\ndefaults: &answers [owner]\nquestions: *answers\n`],
    ["custom tag", `apiVersion: harness.planeon.ai/questionnaire/v1alpha1\nkind: Questionnaire\nid: synthetic.business-context\nstage: business-context\ntitle: Tag refused\nquestions: !unsafe []\n`],
  ])("rejects YAML %s", (_name, questionnaireOverride) => {
    const fixture = buildSignedPackFixture({ questionnaireOverride });
    expect(code(() => admitIndustryPack(fixture.envelope, fixture.archive, fixture.registry, NOW))).toMatch(/^PACK_YAML_(?:FEATURE_)?REFUSED$/u);
  });

  it("loads only a bounded local regular-file trust registry", async () => {
    const fixture = buildSignedPackFixture();
    const root = await mkdtemp(join(tmpdir(), "questionnaire-trust-"));
    await writeFile(join(root, "registry.json"), JSON.stringify(fixture.registry), { mode: 0o600 });
    const registry = await loadIndustryPackTrustRegistry("registry.json", root);
    expect(registry.keys[0].keyId).toBe("synthetic-release-key");

    await mkdir(join(root, "outside"));
    await symlink(join(root, "registry.json"), join(root, "outside", "linked.json"));
    await expect(loadIndustryPackTrustRegistry("outside/linked.json", root)).rejects.toMatchObject({ code: "PACK_TRUST_PATH_REFUSED" });
  });

  it("fails closed while parsing duplicate or wrong-purpose trust authority", () => {
    const fixture = buildSignedPackFixture();
    expect(code(() => parseTrustRegistry({ ...fixture.registry, keys: [...fixture.registry.keys, ...fixture.registry.keys] }))).toBe("PACK_TRUST_REGISTRY_REFUSED");
    expect(code(() => parseTrustRegistry({ ...fixture.registry, keys: [{ ...fixture.registry.keys[0], purpose: "TENANT_LIVE_EXECUTION" }] }))).toBe("PACK_TRUST_KEY_REFUSED");
  });
});
