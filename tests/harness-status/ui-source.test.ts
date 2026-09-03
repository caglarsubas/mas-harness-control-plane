import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");
const overview = read("apps/control-web/src/components/harness-overview/OverviewPage.tsx");
const onion = read("apps/control-web/src/components/harness-overview/HarnessOnion.tsx");
const details = read("apps/control-web/src/components/harness-overview/DetailPages.tsx");
const document = read("apps/control-web/src/components/harness-overview/render-document.ts");
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
    expect(onion).toContain("<nav");
    expect(onion).toContain('data-onion-navigation="true"');
    expect(onion).not.toMatch(/role="(?:listbox|option)"|aria-selected|tabIndex=/u);
    expect(document).not.toMatch(/role=\\?"?(?:listbox|option)|aria-selected|tabindex=/u);
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

  it("exposes complete digests accessibly without title-only disclosure", () => {
    for (const label of ["Full profile digest:", "Full bundle digest:", "Full release digest:"]) {
      expect(overview).toContain(label);
      expect(document).toContain(label);
    }
    expect(details).toContain("Full current release digest:");
    expect(`${overview}\n${details}`).not.toContain("title={");
  });

  it("provides local-first light and dark themes with stripe-free status treatments", () => {
    expect(css).toContain("color-scheme: light dark");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain('font-family: "Avenir Next", Avenir, "Segoe UI Variable", sans-serif');
    expect(css).not.toMatch(/border-(?:left|right|inline-start|inline-end):\s*[2-9]/u);
    expect(document).toContain("prefers-color-scheme:dark");
    expect(document).not.toMatch(/border-(?:left|right):[2-9]/u);
  });

  it("contains no remote assets, analytics, or public browser endpoints", () => {
    const combined = `${overview}\n${onion}\n${details}\n${document}\n${css}\n${routes}`;
    expect(combined).not.toMatch(/https?:\/\//u);
    expect(combined).not.toMatch(/analytics|vercel|googleapis|unsplash/iu);
  });
});
