import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const catalogue = readFileSync(resolve(ROOT, "apps/control-web/src/app/questionnaires/QuestionnaireCatalogue.tsx"), "utf8");
const journey = readFileSync(resolve(ROOT, "apps/control-web/src/app/questionnaires/[sessionId]/[stageId]/QuestionnaireJourney.tsx"), "utf8");
const styles = readFileSync(resolve(ROOT, "apps/control-web/src/app/questionnaires/questionnaire.module.css"), "utf8");
const contracts = readFileSync(resolve(ROOT, "apps/control-web/src/lib/questionnaire/contracts.ts"), "utf8");

describe("responsive semantic questionnaire source", () => {
  it("shows the signed-pack catalogue and all named progress rather than number-only stages", () => {
    expect(catalogue).toContain("Only admitted releases appear here");
    expect(catalogue).toContain("Start guided setup");
    for (const label of ["Business context", "Domain and outcomes", "Data readiness", "Governance and regulation", "Integration readiness", "Harness demand", "Environment and provider fit", "Evidence and acceptance"]) {
      expect(contracts).toContain(`title: "${label}"`);
    }
    expect(journey).toContain("item.title");
    expect(journey).toContain('aria-current={item.id === stageId ? "step" : undefined}');
  });

  it("contains accessible save, resume, review, loading, empty, error, and findings states", () => {
    for (const source of [
      "Save and continue", "Review readiness", "Restoring the latest saved revision", "Items required before readiness",
      "role=\"alert\"", "role=\"progressbar\"", "aria-live", "fieldset", "legend", "label htmlFor",
    ]) expect(journey + catalogue).toContain(source);
    expect(catalogue).toContain("No admitted industry pack yet");
    expect(journey).toContain("credentials: \"same-origin\"");
  });

  it("reflows for mobile, preserves focus, honors reduced motion, and uses no public asset", () => {
    expect(styles).toContain("@media (max-width: 820px)");
    expect(styles).toContain("@media (max-width: 520px)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain(":focus-visible");
    expect(catalogue + journey + styles).not.toMatch(/https?:\/\//u);
    expect(catalogue + journey).not.toMatch(/(?:analytics|telemetry|remote font|cdn)/iu);
  });
});
