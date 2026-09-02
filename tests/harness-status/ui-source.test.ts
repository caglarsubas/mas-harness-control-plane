import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");
const overview = read("apps/control-web/src/components/harness-overview/OverviewPage.tsx");
const onion = read("apps/control-web/src/components/harness-overview/HarnessOnion.tsx");
const details = read("apps/control-web/src/components/harness-overview/DetailPages.tsx");
const css = read("apps/control-web/src/components/harness-overview/overview.module.css");
const routes = [
  "apps/control-web/src/app/overview/page.tsx",
  "apps/control-web/src/app/planes/[planeId]/page.tsx",
  "apps/control-web/src/app/harnesses/[harnessId]/page.tsx",
  "apps/control-web/src/app/organizations/page.tsx",
  "apps/control-web/src/app/organizations/[organizationId]/page.tsx",
].map(read).join("\n");

describe("overview source semantics", () => {
  it("keeps the onion and complete semantic list linked to stable detail routes", () => {
    expect(onion).toContain('role="listbox"');
    expect(onion).toContain('role="option"');
    expect(onion).toContain("ArrowRight");
    expect(overview).toContain("Accessible equivalent");
    expect(overview).toContain("/planes/${plane.id}");
    expect(overview).toContain("/harnesses/${summary.harnessId}");
    expect(routes).toContain("createFixtureProjectionSet");
  });

  it("renders immutable bindings, freshness, findings, filters, and all eleven axes without a score", () => {
    for (const phrase of ["Immutable projection bindings", "Findings that need a decision", "Aggregate state", "Evidence axis", "Selection", "Eleven independent proof axes"]) expect(overview).toContain(phrase);
    expect(details).toContain("underlying");
    expect(overview.toLowerCase()).not.toContain("health score");
  });

  it("has mobile list-first fallback, focus, reduced motion, reflow, non-color state, and tactile controls", () => {
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain(".onionPanel { display: none; }");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(":active");
    expect(css).toContain("text-decoration: underline dashed");
    expect(css).toContain("min-block-size: 44px");
  });

  it("contains no remote assets, analytics, or public browser endpoints", () => {
    const combined = `${overview}\n${onion}\n${details}\n${css}\n${routes}`;
    expect(combined).not.toMatch(/https?:\/\//u);
    expect(combined).not.toMatch(/analytics|vercel|googleapis|unsplash/iu);
  });
});

