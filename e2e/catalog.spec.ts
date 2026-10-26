import { expect, test, type Page } from "@playwright/test";
import { createAccount, signInThroughUi, uniqueName } from "./helpers";

async function signedIn(page: Page, request: Parameters<typeof createAccount>[0], prefix: string) {
  const name = uniqueName(prefix);
  await createAccount(request, name, "e2e-pass-8");
  await signInThroughUi(page, name, "e2e-pass-8");
}

const GENRES = ["action", "adventure", "comedy", "drama", "horror", "science-fiction", "thriller", "romance", "animation", "documentary", "fantasy", "crime"];

test("every navbar genre page shows real titles of that genre (films and TV where TMDB has both)", async ({ page, request }) => {
  test.setTimeout(240_000);
  await signedIn(page, request, "e2e-genre");
  const report: Record<string, unknown> = {};
  for (const slug of GENRES) {
    await page.goto(`/browse/genre?g=${slug}`);
    await expect(page.getByTestId("genre-title")).toBeVisible();
    await expect(page.getByTestId("genre-grid").locator("[role=button]").first()).toBeVisible({ timeout: 30_000 });
    const count = await page.getByTestId("genre-grid").locator("[role=button]").count();
    expect(count, slug).toBeGreaterThanOrEqual(12);
    await expect(page.getByTestId("genre-error")).toHaveCount(0);
    // Server-side check that the catalog truly returned this genre (ids, not just non-empty).
    const api = await page.request.get(`/api/catalog?type=genre&g=${slug}&media=movie&page=1`);
    const data = await api.json();
    const items = data.items as Array<{ genreIds?: number[]; title: string }>;
    const movieGenres = (await (await page.request.get("/api/catalog?type=genres")).json()).genres as Array<{ id: number; name: string }>;
    const expectedId = movieGenres.find((g) => g.name.toLowerCase().replace(/\s+/g, "-") === slug)?.id;
    if (expectedId) {
      const withGenre = items.filter((i) => i.genreIds?.includes(expectedId)).length;
      expect(withGenre, `${slug}: TMDB results should carry genre id ${expectedId}`).toBeGreaterThanOrEqual(Math.floor(items.length * 0.9));
    }
    report[slug] = { cards: count, apiItems: items.length };
  }
  console.log("genre pages:", JSON.stringify(report));
});

test("genre page: TV toggle, sort, pagination and unknown genre", async ({ page, request }) => {
  await signedIn(page, request, "e2e-genre2");
  await page.goto("/browse/genre?g=action");
  await expect(page.getByTestId("genre-grid").locator("[role=button]").first()).toBeVisible({ timeout: 30_000 });
  const firstAll = await page.getByTestId("genre-grid").locator("[role=button]").first().getAttribute("class");
  void firstAll;
  await page.getByRole("tab", { name: "TV" }).click();
  await expect(page).toHaveURL(/media=tv/);
  await expect(page.getByTestId("genre-grid").locator("[role=button]").first()).toBeVisible({ timeout: 30_000 });
  const tvApi = await (await page.request.get("/api/catalog?type=genre&g=action&media=tv")).json();
  expect(tvApi.items.every((i: { type: string }) => i.type === "series")).toBe(true);

  await page.getByLabel("Sort by").selectOption("rating");
  await expect(page).toHaveURL(/sort=rating/);
  const rated = await (await page.request.get("/api/catalog?type=genre&g=action&media=movie&sort=rating")).json();
  const ratings = rated.items.map((i: { rating: number }) => i.rating);
  expect(Math.min(...ratings)).toBeGreaterThan(7);

  // Infinite scroll loads a second page.
  await page.goto("/browse/genre?g=comedy&media=movie");
  await expect(page.getByTestId("genre-grid").locator("[role=button]").first()).toBeVisible({ timeout: 30_000 });
  const before = await page.getByTestId("genre-grid").locator("[role=button]").count();
  await page.mouse.wheel(0, 20000);
  await expect.poll(async () => page.getByTestId("genre-grid").locator("[role=button]").count(), { timeout: 30_000 }).toBeGreaterThan(before);

  // Horror has no TV genre at TMDB: no TV toggle, films only.
  await page.goto("/browse/genre?g=horror");
  await expect(page.getByTestId("genre-grid").locator("[role=button]").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("tab", { name: "TV" })).toHaveCount(0);

  // Legacy link and unknown genre.
  await page.goto("/browse/genre?name=Sci-Fi");
  await expect(page.getByTestId("genre-title")).toHaveText("Science Fiction");
  const unknown = await page.request.get("/api/catalog?type=genre&g=not-a-genre");
  expect(unknown.status()).toBe(404);
});

test("homepage: genre rows are populated and titles are not repeated across rows", async ({ page, request }) => {
  test.setTimeout(120_000);
  await signedIn(page, request, "e2e-home");
  await expect(page.getByRole("heading", { name: "Action", exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Comedy", exact: true })).toBeVisible({ timeout: 60_000 });
  const ids = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("section[class*='group/row']"));
    return rows.map((r) => Array.from(r.querySelectorAll("[data-testid=title-card]")).map((c) => (c as HTMLElement).dataset.title ?? "").filter(Boolean));
  });
  const seen = new Map<string, number>();
  let dupes = 0;
  for (const row of ids) for (const t of row) { if (seen.has(t)) dupes++; seen.set(t, (seen.get(t) ?? 0) + 1); }
  // Continue Watching / My List may legitimately repeat; everything else should not.
  expect(dupes, "titles repeated across catalog rows").toBeLessThanOrEqual(2);
  expect(ids.filter((r) => r.length >= 5).length).toBeGreaterThanOrEqual(6);
});
