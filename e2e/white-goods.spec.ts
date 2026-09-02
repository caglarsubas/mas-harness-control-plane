import { chromium, expect, test } from "@playwright/test";

import { WHITE_GOODS_JOURNEY, renderWhiteGoodsJourney } from "../apps/control-web/src/lib/security/white-goods-journey";

const CHROMIUM_EXECUTABLE = "/opt/planeon/browser/ctrl-006/chrome-headless-shell-mac-arm64/chrome-headless-shell";

test("keyboard-only white-goods journey reaches one bounded bundle request", async () => {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_EXECUTABLE,
    headless: true,
    args: ["--disable-background-networking", "--disable-breakpad", "--disable-component-update", "--no-first-run"],
  });
  try {
    expect(browser.version()).toBe("149.0.7827.55");
    const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const disallowed: string[] = [];
    page.on("request", (request) => {
      if (!/^(?:about|data):/u.test(request.url())) disallowed.push(request.url());
    });
    await page.setContent(renderWhiteGoodsJourney(), { waitUntil: "domcontentloaded" });
    await page.locator("#next").focus();
    for (let index = 1; index < WHITE_GOODS_JOURNEY.length; index += 1) await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Bundle handoff" })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("State 7 of 7: REQUESTED");
    await expect(page.locator('[data-step="6"]')).toHaveAttribute("aria-current", "step");
    await expect(page.getByText(/not artifact proof, deployment, runtime health, assurance, or tenant acceptance/u)).toBeVisible();
    expect(disallowed).toEqual([]);
    await context.close();
  } finally {
    await browser.close();
  }
});
