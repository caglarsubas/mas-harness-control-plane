import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ui = readFileSync(resolve("apps/control-web/src/app/profiles/ProfileWorkbench.tsx"), "utf8");
const css = readFileSync(resolve("apps/control-web/src/app/profiles/profile.module.css"), "utf8");

describe("CTRL-005 profile review UI contract", () => {
  it("keeps named harness, module, provider, explanation, approval, lock, and bundle surfaces visible", () => {
    for (const text of ["Harnesses", "Modules", "Providers", "Compiler rationale", "Approval & handoff", "Lock profile", "Request bundle build"]) {
      expect(ui).toContain(text);
    }
  });

  it("states the evidence boundaries rather than collapsing them into readiness", () => {
    for (const text of ["artifact SBOM", "local signature verification", "deployment", "runtime health", "security", "assurance", "tenant acceptance"]) {
      expect(ui).toContain(text);
    }
  });

  it("provides semantic landmarks, keyboard-visible focus, responsive layouts, and reduced motion", () => {
    expect(ui).toContain("aria-live=\"polite\"");
    expect(ui).toContain("<nav aria-label=");
    expect(ui).toContain("<main");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("@media (max-width: 780px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
