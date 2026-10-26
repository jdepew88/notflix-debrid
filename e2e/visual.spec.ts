import fs from "node:fs";
import path from "node:path";
import { test, type Page } from "@playwright/test";
import { createAccount, uniqueName } from "./helpers";

/**
 * Visual review captures (not assertions): every main screen at desktop, tablet and phone sizes.
 *   E2E_SCREENSHOTS_DIR=<folder> npx playwright test e2e/visual.spec.ts
 * Skipped unless E2E_SCREENSHOTS_DIR is set.
 */
const OUT = process.env.E2E_SCREENSHOTS_DIR;
const SIZES = [
  { name: "desktop", width: 1920, height: 1080 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "mobile", width: 390, height: 844 },
];

async function settle(page: Page, ms = 1500) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(ms);
}

for (const size of SIZES) {
  test(`screens at ${size.name}`, async ({ browser, baseURL, request }) => {
    test.skip(!OUT, "set E2E_SCREENSHOTS_DIR to capture screenshots");
    test.setTimeout(240_000);
    const dir = path.join(OUT!, size.name);
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await browser.newContext({ baseURL, viewport: { width: size.width, height: size.height }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const shot = (name: string, fullPage = false) => page.screenshot({ path: path.join(dir, `${name}.png`), fullPage });

    await page.goto("/");
    await settle(page, 2500);
    await shot("01-login");
    await page.goto("/signup");
    await settle(page);
    await shot("02-signup");

    const name = uniqueName("e2e-visual");
    await createAccount(request, name, "e2e-pass-8");
    await page.goto("/");
    await page.getByLabel("Username").fill(name);
    await page.getByLabel("Password", { exact: true }).fill("e2e-pass-8");
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await page.waitForURL(/\/profiles/);
    await settle(page);
    await page.mouse.move(1, 1);
    await shot("03-profiles");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await shot("04-profiles-focus");
    await page.getByTestId("profiles-manage").click();
    await settle(page, 500);
    await shot("05-profiles-manage");
    await page.getByTestId("profile-tile").first().click();
    await settle(page, 1200);
    await shot("06-profile-editor");
    await page.keyboard.press("Escape");
    await page.getByTestId("profiles-manage").click();
    await page.getByTestId("profile-tile").first().click();
    await page.waitForURL(/\/browse/);
    await settle(page, 3500);
    await shot("07-home");
    await page.mouse.wheel(0, 900);
    await settle(page, 1200);
    await shot("08-home-rows");
    await page.goto("/browse/genre?g=action");
    await page.mouse.move(1, 1);
    await settle(page, 2500);
    await shot("09-genre");
    await page.locator("[data-testid=genre-grid] [role=button]").first().focus();
    await shot("10-genre-focus");
    await page.keyboard.press("Enter");
    await settle(page, 2500);
    await shot("11-details");
    await page.keyboard.press("Escape");
    await page.goto("/browse/search");
    await page.getByPlaceholder("Titles, people, genres").fill("star");
    await settle(page, 3000);
    await shot("12-search");
    await page.goto("/browse/my-list");
    await settle(page, 2000);
    await shot("13-my-list");
    await page.goto("/browse");
    await settle(page, 2500);
    await page.mouse.move(1, 1);
    await page.getByTestId("site-footer").scrollIntoViewIfNeeded();
    await settle(page, 1500);
    await page.getByTestId("site-footer").scrollIntoViewIfNeeded();
    await shot("14-footer");
    await page.goto("/settings");
    await settle(page, 1500);
    await shot("15-settings");
    await ctx.close();
  });
}
