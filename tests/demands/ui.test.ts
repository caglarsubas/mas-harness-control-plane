import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const component = readFileSync(resolve("apps/control-web/src/app/demands/DemandWorkbench.tsx"), "utf8");
const styles = readFileSync(resolve("apps/control-web/src/app/demands/demand.module.css"), "utf8");

describe("professional demand and approval UI source", () => {
  it("shows named lifecycle, explicit prerequisite decisions, findings, and quorum", () => {
    for (const label of ["Draft", "Validated", "Approval pending", "Approved", "Accept", "Reject", "Validation findings", "Approval quorum"]) {
      expect(component).toContain(label);
    }
    expect(component).toContain("requester cannot review their own demand");
    expect(component).toContain('aria-live="polite"');
    expect(component).toContain('aria-busy={viewState === "submitting"}');
  });

  it("uses only same-origin routes and local styling", () => {
    expect(component).toContain('sameOriginRequest("/api/v1alpha1/demands"');
    expect(component).toContain("/api/v1alpha1/approvals/");
    expect(component).not.toMatch(/https?:\/\//u);
    expect(styles).not.toMatch(/url\(|@import/u);
  });

  it("includes responsive, keyboard-focus, touch-target, and reduced-motion treatment", () => {
    expect(styles).toContain("min-height: 44px");
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("@media (max-width: 760px)");
    expect(styles).toContain("@media (max-width: 520px)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

