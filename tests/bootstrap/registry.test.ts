import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadIssuerRegistry } from "../../apps/control-web/src/lib/foundation/oidc";
import { fixture } from "./oidc-fixture";

describe("local closed issuer registry", () => {
  it("loads a regular closed file and rejects unknown members", async () => {
    const root = await mkdtemp(join(tmpdir(), "planeon-oidc-registry-"));
    try {
      const { registry } = fixture();
      await writeFile(join(root, "registry.json"), JSON.stringify(registry), { encoding: "utf8", mode: 0o600 });
      expect((await loadIssuerRegistry("registry.json", root)).bindings).toHaveLength(1);
      const invalid = {
        ...registry,
        bindings: [{ ...registry.bindings[0], discoveryUrl: "https://discovery.example.invalid" }],
      };
      await writeFile(join(root, "invalid.json"), JSON.stringify(invalid), "utf8");
      await expect(loadIssuerRegistry("invalid.json", root)).rejects.toMatchObject({ code: "OIDC_BINDING_UNKNOWN_MEMBER" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a linked registry that escapes the configured root", async () => {
    const root = await mkdtemp(join(tmpdir(), "planeon-oidc-link-"));
    const outside = await mkdtemp(join(tmpdir(), "planeon-oidc-outside-"));
    try {
      const target = join(outside, "registry.json");
      await writeFile(target, JSON.stringify(fixture().registry), "utf8");
      await symlink(target, join(root, "registry.json"));
      await expect(loadIssuerRegistry("registry.json", root)).rejects.toMatchObject({ code: "OIDC_REGISTRY_PATH_REFUSED" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
