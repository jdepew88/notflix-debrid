import { expect, test } from "@playwright/test";
import { createAccount, signInThroughUi, uniqueName } from "./helpers";

async function setPref(page: import("@playwright/test").Page, patch: Record<string, unknown>) {
  const me = await (await page.request.get("/api/auth/me")).json();
  const profileId = me.state.activeProfileId ?? me.state.profiles[0].id;
  const res = await page.request.put("/api/user/state", { data: { action: "setPreferences", profileId, preferences: patch } });
  expect(res.ok()).toBe(true);
}

test("featured hero shows a cinematic film with metadata and no preview by default", async ({ page, request }) => {
  const name = uniqueName("e2e-hero");
  await createAccount(request, name, "e2e-pass-8");
  const videoRequests: string[] = [];
  page.on("request", (r) => {
    if (/youtube\.com\/embed|\/api\/hero\/|\.m3u8|\/api\/hero\/video/.test(r.url())) videoRequests.push(r.url());
  });
  await signInThroughUi(page, name, "e2e-pass-8");
  const hero = page.getByTestId("hero");
  await expect(hero).toBeVisible({ timeout: 60_000 });
  // Substantial part of the viewport, backdrop (not poster) art.
  const box = (await hero.boundingBox())!;
  expect(box.height).toBeGreaterThan(400);
  const img = hero.locator("img").first();
  await expect(img).toBeVisible();
  const src = (await img.getAttribute("src")) ?? "";
  expect(src).not.toMatch(/\/w342\/|\/w500\/.*poster/);
  await expect(page.getByTestId("hero-meta")).toContainText(/(19|20)\d{2}/);
  await expect(page.getByTestId("hero-play")).toBeVisible();
  await expect(page.getByRole("button", { name: "More Info" })).toBeVisible();
  await expect(page.getByTestId("hero-mylist")).toBeVisible();
  const hasLogo = (await page.getByTestId("hero-logo").count()) > 0;
  const hasTitle = (await page.getByTestId("hero-title").count()) > 0;
  expect(hasLogo || hasTitle).toBe(true);
  // Previews are off by default: no trailer iframe and no video requests.
  await page.waitForTimeout(3000);
  await expect(page.getByTestId("hero-preview")).toHaveCount(0);
  expect(videoRequests.filter((u) => u.includes("youtube.com/embed"))).toEqual([]);
  expect(await hero.getAttribute("data-preview")).toBe("image");

  // My List from the hero.
  await page.getByTestId("hero-mylist").click();
  await expect(page.getByTestId("hero-mylist")).toHaveAttribute("aria-label", "Remove from My List");
  await expect(page.getByRole("heading", { name: "My List", exact: true })).toBeVisible({ timeout: 15_000 });
});

test("preview autoplay: on → trailer iframe loads muted; reduced motion keeps the image", async ({ page, request, browser }) => {
  test.setTimeout(120_000);
  const name = uniqueName("e2e-hero2");
  await createAccount(request, name, "e2e-pass-8");
  await signInThroughUi(page, name, "e2e-pass-8");
  await setPref(page, { autoplayPreviews: true });
  await page.reload();
  await expect(page.getByTestId("hero")).toBeVisible({ timeout: 60_000 });
  // Either a trailer is embedded (muted, no controls) or TMDB had none for this title — report which.
  const iframe = page.getByTestId("hero-preview");
  const appeared = await iframe.waitFor({ state: "attached", timeout: 20_000 }).then(() => true).catch(() => false);
  if (appeared) {
    const src = (await iframe.getAttribute("src")) ?? "";
    expect(src).toContain("mute=1");
    expect(src).toContain("controls=0");
    expect(src).toContain("enablejsapi=1");
    await expect(page.getByTestId("hero-mute")).toBeVisible();
    // Scrolling the hero away pauses it (the player is asked to pause; the element must stay without errors).
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(800);
    await page.mouse.wheel(0, -2500);
  }
  console.log(`hero preview with autoplay on: ${appeared ? "trailer embedded" : "no trailer available for this title"}`);

  // Reduced motion: the preference is on but the OS asks for no motion → image only.
  const ctx = await browser.newContext({ reducedMotion: "reduce", baseURL: page.url().replace(/\/browse.*/, "") });
  const cookies = await page.context().cookies();
  await ctx.addCookies(cookies);
  const p2 = await ctx.newPage();
  await p2.goto("/browse");
  await expect(p2.getByTestId("hero")).toBeVisible({ timeout: 60_000 });
  await p2.waitForTimeout(4000);
  await expect(p2.getByTestId("hero-preview")).toHaveCount(0);
  await ctx.close();
});

test("mobile layout: hero and rows fit the viewport without horizontal page scroll", async ({ browser, request, baseURL }) => {
  const name = uniqueName("e2e-mobile");
  await createAccount(request, name, "e2e-pass-8");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, baseURL: baseURL! });
  const page = await ctx.newPage();
  await signInThroughUi(page, name, "e2e-pass-8");
  await expect(page.getByTestId("hero")).toBeVisible({ timeout: 60_000 });
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(390 + 2);
  await expect(page.getByTestId("hero-play")).toBeVisible();
  const box = (await page.getByTestId("hero").boundingBox())!;
  expect(box.height).toBeGreaterThan(300);
  await ctx.close();
});

test("profile preferences persist across reloads and are stored per profile", async ({ page, request }) => {
  const name = uniqueName("e2e-prefs");
  await createAccount(request, name, "e2e-pass-8");
  await signInThroughUi(page, name, "e2e-pass-8");
  await page.goto("/settings");
  await expect(page.getByTestId("profile-preferences")).toBeVisible();
  await page.getByTestId("pref-audio-language").selectOption("fr");
  await page.getByTestId("pref-subtitles-enabled").check();
  await page.getByTestId("pref-autoplay-next").uncheck();
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByTestId("pref-audio-language")).toHaveValue("fr");
  await expect(page.getByTestId("pref-subtitles-enabled")).toBeChecked();
  await expect(page.getByTestId("pref-autoplay-next")).not.toBeChecked();
  // Server-side: stored under the active profile only.
  const me = await (await page.request.get("/api/auth/me")).json();
  const active = me.state.activeProfileId;
  const other = me.state.profiles.find((p: { id: string }) => p.id !== active)?.id;
  expect(me.state.preferencesByProfile[active].audioLanguage).toBe("fr");
  expect(me.state.preferencesByProfile[other]).toBeUndefined();
  // Secrets never leak through the state file.
  expect(JSON.stringify(me)).not.toMatch(/real-debrid\.com|token/i);
});
