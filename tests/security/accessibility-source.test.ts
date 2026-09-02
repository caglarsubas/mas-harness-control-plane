import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("CTRL-001 through CTRL-005 page accessibility closure", () => {
  it("provides one keyboard-visible skip target on every page state", () => {
    const layout = read("apps/control-web/src/app/layout.tsx");
    const global = read("apps/control-web/src/app/security.css");
    expect(layout).toContain('href="#main-content"');
    expect(layout).toContain("Skip to main content");
    for (const path of [
      "apps/control-web/src/app/questionnaires/QuestionnaireCatalogue.tsx",
      "apps/control-web/src/app/questionnaires/[sessionId]/[stageId]/QuestionnaireJourney.tsx",
      "apps/control-web/src/app/questionnaires/loading.tsx",
      "apps/control-web/src/app/questionnaires/error.tsx",
      "apps/control-web/src/app/demands/DemandWorkbench.tsx",
      "apps/control-web/src/app/demands/loading.tsx",
      "apps/control-web/src/app/demands/error.tsx",
      "apps/control-web/src/app/profiles/ProfileWorkbench.tsx",
      "apps/control-web/src/app/profiles/loading.tsx",
      "apps/control-web/src/app/profiles/error.tsx",
    ]) {
      expect(read(path), path).toContain('id="main-content"');
      expect(read(path), path).toContain("tabIndex={-1}");
    }
    expect(global).toContain(".skip-link:focus");
    expect(global).toContain(":focus-visible");
  });

  it("retains reflow, target-size, and reduced-motion rules without a remote asset", () => {
    const global = read("apps/control-web/src/app/security.css");
    expect(global).toContain("min-block-size: 44px");
    expect(global).toContain("@media (prefers-reduced-motion: reduce)");
    expect(global).not.toMatch(/(?:@import|url\(|https?:\/\/)/u);
  });
});
