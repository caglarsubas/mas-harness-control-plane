import { chromium, expect, test } from "@playwright/test";

import { renderHarnessOverviewDocument } from "../apps/control-web/src/components/harness-overview/render-document";

const CHROMIUM_EXECUTABLE = "/opt/planeon/browser/ctrl-006/chrome-headless-shell-mac-arm64/chrome-headless-shell";

async function browserPage(options: { readonly reducedMotion?: "reduce"; readonly width?: number } = {}) {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_EXECUTABLE,
    headless: true,
    args: ["--disable-background-networking", "--disable-breakpad", "--disable-component-update", "--no-first-run"],
  });
  expect(browser.version()).toBe("149.0.7827.55");
  const context = await browser.newContext({ reducedMotion: options.reducedMotion, viewport: { width: options.width ?? 1280, height: 900 } });
  const page = await context.newPage();
  const disallowed: string[] = [];
  page.on("request", (request) => { if (!/^(?:about|data):/u.test(request.url())) disallowed.push(request.url()); });
  return { browser, context, page, disallowed };
}

test("portfolio, overview, plane, and harness destinations remain stable in browser history", async () => {
  const { browser, context, page, disallowed } = await browserPage();
  try {
    await page.setContent(renderHarnessOverviewDocument({ view: "portfolio" }), { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Organization harness posture" })).toBeVisible();
    await page.getByRole("link", { name: /Marmara Thermal Systems/u }).click();
    expect(await page.evaluate(() => location.hash)).toBe("#/organizations/org.marmara-thermal");
    await page.setContent(renderHarnessOverviewDocument(), { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Knowledge plane" }).click();
    expect(await page.evaluate(() => location.hash)).toBe("#/planes/knowledge");
    await page.getByRole("link", { name: /Data Integration & Provenance/u }).last().click();
    expect(await page.evaluate(() => location.hash)).toBe("#/harnesses/knowledge.data-integration");
    await page.goBack();
    expect(await page.evaluate(() => location.hash)).toBe("#/planes/knowledge");
    expect(disallowed).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("filters update the URL and both semantic state and result announcement", async () => {
  const { browser, context, page, disallowed } = await browserPage();
  try {
    await page.setContent(renderHarnessOverviewDocument(), { waitUntil: "domcontentloaded" });
    await page.getByLabel("Aggregate state").selectOption("BLOCKED");
    await page.getByRole("button", { name: "Apply filters" }).click();
    expect(await page.evaluate(() => location.hash)).toBe("#/overview?state=BLOCKED");
    await expect(page.getByRole("status")).toHaveText("Showing 1 of 16 harnesses.");
    await expect(page.locator('li[data-state="READY"]').first()).toHaveAttribute("data-hidden", "true");
    await expect(page.locator('li[data-state="BLOCKED"]')).not.toHaveAttribute("data-hidden", "true");
    expect(disallowed).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("the onion uses one tab stop and clockwise arrow navigation with named state", async () => {
  const { browser, context, page, disallowed } = await browserPage({ reducedMotion: "reduce" });
  try {
    await page.setContent(renderHarnessOverviewDocument(), { waitUntil: "domcontentloaded" });
    const options = page.getByRole("listbox", { name: "Sixteen harnesses arranged by plane" }).getByRole("option");
    await options.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(options.nth(1)).toBeFocused();
    await expect(options.nth(1)).toHaveAttribute("aria-label", /Model & Inference: EMPTY; CURRENT; 0 blockers/u);
    expect(await options.evaluateAll((nodes) => nodes.filter((node) => (node as HTMLElement).tabIndex === 0).length)).toBe(1);
    await page.keyboard.press("End");
    await expect(options.nth(15)).toBeFocused();
    expect(disallowed).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("empty, loading, stale, source-loss, and unauthorized states never fabricate health", async () => {
  const { browser, context, page, disallowed } = await browserPage();
  try {
    for (const [state, heading] of [["LOADING", "Loading the verified harness projection"], ["EMPTY", "No harness demand exists yet."], ["UNAUTHORIZED", "The organization view is unavailable."]] as const) {
      await page.setContent(renderHarnessOverviewDocument({ state }), { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
    await page.setContent(renderHarnessOverviewDocument({ freshness: "STALE" }), { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("alert")).toContainText("Current health is withheld");
    await expect(page.getByRole("alert")).toContainText("STALE");
    await page.setContent(renderHarnessOverviewDocument({ freshness: "SOURCE_UNAVAILABLE" }), { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("alert")).toContainText("SOURCE UNAVAILABLE");
    expect(disallowed).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("semantic fallback reflows at 320 CSS pixels and remains usable at 200 percent zoom", async () => {
  const { browser, context, page, disallowed } = await browserPage({ reducedMotion: "reduce", width: 320 });
  try {
    await page.setContent(renderHarnessOverviewDocument(), { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(page.getByLabel("Accessible equivalent")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => { document.body.style.zoom = "200%"; });
    await expect(page.getByRole("heading", { name: "Marmara Thermal Systems" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Security, Safety & Guardrails/u })).toBeVisible();
    expect(disallowed).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("zero public requests or remote assets are emitted by the production-derived overview", async () => {
  const { browser, context, page, disallowed } = await browserPage();
  try {
    await page.setContent(renderHarnessOverviewDocument(), { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Marmara Thermal Systems" })).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Sixteen harnesses arranged by plane" }).getByRole("option")).toHaveCount(16);
    expect(disallowed).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
});
