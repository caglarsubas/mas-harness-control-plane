import { chromium, expect, test } from "@playwright/test";

import { renderWhiteGoodsJourney } from "../../apps/control-web/src/lib/security/white-goods-journey";

const CHROMIUM_EXECUTABLE = "/opt/planeon/browser/ctrl-006/chrome-headless-shell-mac-arm64/chrome-headless-shell";

test("semantic journey reflows, zooms, announces state, and honors reduced motion", async () => {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_EXECUTABLE,
    headless: true,
    args: ["--disable-background-networking", "--disable-breakpad", "--disable-component-update", "--no-first-run"],
  });
  try {
    expect(browser.version()).toBe("149.0.7827.55");
    const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 640, height: 900 } });
    const page = await context.newPage();
    await page.setContent(renderWhiteGoodsJourney(), { waitUntil: "domcontentloaded" });
    expect(await page.getByRole("main").count()).toBe(1);
    expect(await page.getByRole("navigation", { name: "Journey states" }).count()).toBe(1);
    expect(await page.getByRole("button").count()).toBe(9);
    const headings = await page.locator("h1,h2").evaluateAll((nodes) => nodes.map((node) => ({ level: Number(node.tagName.slice(1)), text: node.textContent })));
    expect(headings.map((heading) => heading.level)).toEqual([1, 2, 2]);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

    await page.getByRole("link", { name: "Skip to main content" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
    await page.getByRole("button", { name: /Demand approved/u }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText("State 2 of 7: APPROVED");
    expect(await page.locator('[aria-current="step"]').getAttribute("data-step")).toBe("1");

    await page.evaluate(() => { document.body.style.zoom = "2"; });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const focus = await page.getByRole("button", { name: /Demand approved/u }).evaluate((element) => getComputedStyle(element, ":focus-visible").outlineStyle);
    expect(focus).not.toBe("none");
    await context.close();
  } finally {
    await browser.close();
  }
});
