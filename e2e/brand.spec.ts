import { expect, test, type Page } from "@playwright/test";
import { createAccount, profilesOf, signInThroughUi, uniqueName } from "./helpers";

const PASSWORD = "e2e-pass-8";

async function visibleText(page: Page) {
  return page.evaluate(() => document.body.innerText);
}

test("NOTFLIX branding everywhere, with no Netflix branding left", async ({ page, request }) => {
  // Public pages: wordmark, tab title, favicon, manifest and social image.
  await page.goto("/");
  await expect(page.getByTestId("notflix-wordmark").first()).toBeVisible();
  await expect(page).toHaveTitle("Notflix");
  expect(await visibleText(page)).not.toMatch(/NETFLIX/);
  const icon = await page.locator('link[rel="icon"]').first().getAttribute("href");
  expect(icon).toMatch(/icon\.svg/);
  expect((await request.get(icon!)).status()).toBe(200);
  const og = await page.locator('meta[property="og:image"]').first().getAttribute("content");
  expect(og).toMatch(/opengraph-image/);
  expect((await request.get(new URL(og!).pathname)).headers()["content-type"]).toBe("image/png");
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  const manifest = await (await request.get(manifestHref!)).json();
  expect(manifest.name).toBe("Notflix");
  for (const i of manifest.icons) expect((await request.get(i.src)).status(), i.src).toBe(200);
  await page.goto("/signup");
  await expect(page.getByTestId("notflix-wordmark").first()).toBeVisible();

  // Signed-in pages.
  const name = uniqueName("e2e-brand");
  await createAccount(request, name, PASSWORD);
  await signInThroughUi(page, name, PASSWORD);
  await expect(page.locator("nav").getByTestId("notflix-wordmark")).toBeVisible();
  expect(await visibleText(page)).not.toMatch(/NETFLIX|Popular on Netflix/);
  await page.goto("/profiles");
  await expect(page.getByTestId("notflix-wordmark").first()).toBeVisible();
});

test("footer has only real destinations and the required attributions", async ({ page, request }) => {
  const name = uniqueName("e2e-footer");
  await createAccount(request, name, PASSWORD);
  await signInThroughUi(page, name, PASSWORD);
  await page.goto("/browse/my-list");
  const footer = page.getByTestId("site-footer");
  await footer.scrollIntoViewIfNeeded();
  await expect(footer).toBeVisible();
  await expect(footer).toContainText("not endorsed or certified by TMDB");
  await expect(footer).toContainText("JustWatch");
  await expect(footer).toContainText(/Version \d+\.\d+\.\d+/);
  const hrefs = await footer.locator("a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) {
    expect(href, "no placeholder links").not.toBe("#");
    if (href.startsWith("/")) expect((await page.request.get(href)).status(), href).toBe(200);
    else expect(href).toMatch(/^https:\/\/www\.(themoviedb\.org|justwatch\.com)\//);
  }
});

test("avatars: rich built-in library, legacy references still render", async ({ page, request }) => {
  const name = uniqueName("e2e-avatars");
  await createAccount(request, name, PASSWORD);
  await signInThroughUi(page, name, PASSWORD);
  // New accounts get the new artwork.
  const main = (await profilesOf(page)).find((p) => p.name === "Main")!;
  expect(main.avatar).toMatch(/^builtin:v2-/);
  // A profile still pointing at a first-generation avatar keeps working (and can be saved again).
  const r = await page.request.post("/api/user/profiles", { data: { action: "update", profileId: main.id, avatar: "builtin:space-rocket" } });
  expect(r.ok()).toBe(true);
  await page.goto("/profiles");
  const img = page.locator("[data-testid=profile-tile][data-profile-name=Main] img");
  await expect(img).toHaveAttribute("src", "/avatars/space-rocket.svg");
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);

  // The picker offers only the new collection; every image loads and is small.
  await page.getByTestId("profiles-manage").click();
  await page.locator("[data-testid=profile-tile][data-profile-name=Main]").click();
  const tiles = page.getByTestId("profile-editor").locator("[data-avatar-id]");
  expect(await tiles.count()).toBeGreaterThanOrEqual(30);
  const ids = await tiles.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.avatarId!));
  expect(ids.every((i) => i.startsWith("v2-"))).toBe(true);
  for (const id of ids) {
    const res = await page.request.get(`/avatars/v2/${id}.webp`);
    expect(res.status(), id).toBe(200);
    expect((await res.body()).length, `${id} size`).toBeLessThan(30_000);
  }
});

test("TV-style navigation: arrows move through the grid, Enter opens details, Escape returns", async ({ page, request }) => {
  const name = uniqueName("e2e-tv");
  await createAccount(request, name, PASSWORD);
  await signInThroughUi(page, name, PASSWORD);
  await page.setViewportSize({ width: 1366, height: 900 }); // 5 columns
  await page.goto("/browse/genre?g=comedy&media=movie");
  const cards = page.getByTestId("genre-grid").locator("[data-testid=title-card]");
  await expect(cards.nth(12)).toBeVisible({ timeout: 30_000 });
  await cards.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(cards.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(cards.nth(6)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(cards.nth(5)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(cards.nth(0)).toBeFocused();
  // Visible focus indicator.
  const ring = await cards.first().evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ring).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("details-play")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("title-details")).toBeHidden();
  await expect(cards.first()).toBeFocused();

  // Profile picker works from the keyboard too.
  await page.goto("/profiles");
  await page.locator("[data-testid=profile-tile]").first().focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/browse/);
});
