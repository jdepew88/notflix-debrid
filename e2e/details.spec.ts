import { expect, test, type Page } from "@playwright/test";
import { createAccount, signInThroughUi, uniqueName } from "./helpers";

async function signedIn(page: Page, request: Parameters<typeof createAccount>[0]) {
  const name = uniqueName("e2e-details");
  await createAccount(request, name, "e2e-pass-8");
  await signInThroughUi(page, name, "e2e-pass-8");
}

/** Column count, gutters and card aspect of the first grid row. */
async function measureGrid(page: Page) {
  return page.getByTestId("genre-grid").evaluate((grid) => {
    const cards = Array.from(grid.children).map((c) => c.getBoundingClientRect());
    const top = cards[0].top;
    const row = cards.filter((r) => Math.abs(r.top - top) < 2);
    const next = cards.find((r) => r.top > top + 2)!;
    return {
      columns: row.length,
      gapX: Math.round(row[1].left - row[0].right),
      gapY: Math.round(next.top - row[0].bottom),
      aspect: row[0].height / row[0].width,
      widths: [...new Set(row.map((r) => Math.round(r.width)))],
      gridWidth: grid.getBoundingClientRect().width,
      scrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      usedWidth: row[row.length - 1].right - row[0].left,
    };
  });
}

test("genre grid is dense and responsive with consistent gutters and poster proportions", async ({ page, request }) => {
  await signedIn(page, request);
  const expected: Array<[number, number, number]> = [
    [2560, 1440, 6], // 1440p desktop
    [1920, 1080, 6],
    [1366, 768, 5],
    [1024, 768, 4],
    [820, 1180, 3], // tablet
    [390, 844, 2], // phone
  ];
  for (const [width, height, columns] of expected) {
    await page.setViewportSize({ width, height });
    await page.goto("/browse/genre?g=action");
    await expect(page.getByTestId("genre-grid").locator("[role=button]").nth(columns + 1)).toBeVisible({ timeout: 30_000 });
    const m = await measureGrid(page);
    console.log(`${width}px: ${m.columns} columns, gap ${m.gapX}×${m.gapY}px, card ${m.widths.join("/")}px, aspect ${m.aspect.toFixed(3)}`);
    expect(m.columns).toBe(columns);
    expect(m.widths.length).toBe(1); // every card in the row has the same width
    expect(m.gapX).toBe(m.gapY); // equal horizontal and vertical spacing
    expect(m.gapX).toBeGreaterThanOrEqual(12);
    expect(m.gapX).toBeLessThanOrEqual(16);
    expect(Math.abs(m.aspect - 9 / 16)).toBeLessThan(0.01); // landscape 16:9 card
    expect(m.usedWidth).toBeGreaterThan(m.gridWidth - 2); // the row spans the full content width
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewport); // no horizontal page scroll
  }
  // Artwork is never stretched: object-cover inside a fixed 16:9 box, landscape backdrops at a card size (w780).
  const art = await page.getByTestId("genre-grid").locator("[data-testid=title-card][data-art=backdrop] img").first().evaluate((img: HTMLImageElement) => ({ fit: getComputedStyle(img).objectFit, src: decodeURIComponent(img.currentSrc) }));
  expect(art.fit).toBe("cover");
  expect(art.src).toContain("/t/p/w780/");
  expect(art.src).not.toContain("/original/");
  // Every card is either a real backdrop or the composed poster fallback, never a distorted poster.
  const kinds = await page.getByTestId("genre-grid").locator("[data-testid=title-card]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.art));
  expect(kinds.every((k) => k === "backdrop" || k === "poster-composite" || k === "placeholder")).toBe(true);
});

test("a poster opens details (no playback); Play starts the right title; Back returns to the details", async ({ page, request }) => {
  await signedIn(page, request);
  const playbackCalls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/playback/start") || r.url().includes("/api/playback/sources")) playbackCalls.push(r.url());
  });
  await page.goto("/browse/genre?g=animation&media=movie");
  const card = page.getByTestId("genre-grid").locator("[role=button]").first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const titleResponse = page.waitForResponse((r) => r.url().includes("/api/catalog?type=title"));
  await card.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/browse\/genre/); // still on the genre page
  const titleUrl = new URL((await titleResponse).url());
  const tmdbId = titleUrl.searchParams.get("id")!;
  await expect(page.getByTestId("details-overview")).toBeVisible();
  await expect(page.getByTestId("details-meta")).toContainText(/(19|20)\d{2}/);
  await expect(dialog.getByRole("heading").first()).toBeVisible();
  await expect(page.getByTestId("details-play")).toBeFocused(); // keyboard: Play is focused first
  expect(playbackCalls).toEqual([]); // opening details never searches Real-Debrid

  // Escape closes and returns focus to the poster.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(card).toBeFocused();

  // Keyboard: Enter on the focused poster reopens the details.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("details-play")).toBeVisible();
  await page.getByTestId("details-play").click();
  await page.waitForURL(new RegExp(`/watch/tmdb-${tmdbId}`));

  // Back from the player returns to the genre page with the same title's details open.
  await page.goBack();
  await expect(page).toHaveURL(/\/browse\/genre\?g=animation/);
  await expect(page.getByTestId("title-details")).toBeVisible({ timeout: 15_000 });
});

test("TV details: season selector, episode list and episode-specific Play", async ({ page, request }) => {
  await signedIn(page, request);
  // Person of Interest (TMDB 1411): five seasons.
  await page.goto("/browse/search");
  await page.getByPlaceholder("Titles, people, genres").fill("Person of Interest");
  const result = page.getByTestId("search-results").getByRole("button", { name: /Person of Interest \(2011\)/ });
  await expect(result).toBeVisible({ timeout: 30_000 });
  await result.click();
  const episodes = page.getByTestId("details-episodes");
  await expect(episodes).toBeVisible({ timeout: 30_000 });
  await expect(episodes.getByTestId("episode").first()).toBeVisible();
  const s1 = await episodes.getByTestId("episode").count();
  expect(s1).toBeGreaterThan(10);
  await expect(episodes.getByTestId("episode").first()).toHaveAttribute("data-season", "1");

  await page.getByTestId("season-select").selectOption("3");
  await expect(episodes.getByTestId("episode").first()).toHaveAttribute("data-season", "3");
  const ep5 = episodes.locator("[data-testid=episode][data-episode='5']");
  await expect(ep5).toContainText(/\S/);
  await ep5.click();
  await page.waitForURL(/\/watch\/tmdb-tv-1411\?.*season=3.*episode=5/);
});

test("Search → details and My List → details → Play", async ({ page, request }) => {
  await signedIn(page, request);
  await page.goto("/browse/search");
  await page.getByPlaceholder("Titles, people, genres").fill("Toy Story");
  const result = page.getByTestId("search-results").getByRole("button", { name: /^Toy Story \(1995\)/ });
  await expect(result).toBeVisible({ timeout: 30_000 });
  await result.click();
  await expect(page.getByTestId("details-overview")).toBeVisible();
  await page.getByTestId("details-mylist").click();
  await expect(page.getByTestId("details-mylist")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");

  await page.goto("/browse/my-list");
  const saved = page.getByTestId("my-list-grid").getByRole("button", { name: /^Toy Story \(1995\)/ });
  await expect(saved).toBeVisible({ timeout: 30_000 });
  await saved.click();
  await page.getByTestId("details-play").click();
  await page.waitForURL(/\/watch\/tmdb-862/);
});

test("mobile: details open near full screen and stay usable", async ({ page, request }) => {
  await signedIn(page, request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/browse/genre?g=comedy&media=movie");
  await page.getByTestId("genre-grid").locator("[role=button]").first().click();
  const panel = page.getByTestId("title-details");
  await expect(panel).toBeVisible();
  // Measured after the short entrance animation (a slight scale-up) has finished.
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThanOrEqual(389);
  await expect(page.getByTestId("details-play")).toBeInViewport();
  await expect(page.getByTestId("details-close")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
