import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createAccount, profilesOf, signInThroughUi, uniqueName } from "./helpers";

const PASSWORD = "e2e-pass-8";
/** Data folder of the server under test (offline account CLI). */
const DATA = process.env.E2E_DATA_PATH;

async function member(page: Page, request: APIRequestContext, prefix = "e2e-member") {
  const name = uniqueName(prefix);
  await createAccount(request, name, PASSWORD);
  await signInThroughUi(page, name, PASSWORD);
  return name;
}

const KIDS_RATINGS = new Set(["G", "PG", "TV-Y", "TV-Y7", "TV-Y7-FV", "TV-G", "TV-PG"]);

test("a regular account cannot read or change server settings or credentials", async ({ page, request }) => {
  await member(page, request);
  const r = page.request;
  expect((await r.post("/api/settings/sync", { data: { maxResolution: 480 } })).status()).toBe(403);
  for (const url of ["/api/config/server", "/api/config/metadata", "/api/config/debrid", "/api/config/hardware", "/api/config/summary", "/api/settings/engine"]) {
    expect((await r.get(url)).status(), url).toBe(403);
  }
  expect((await r.put("/api/config/debrid", { data: { token: "STOLENTOKEN0123456789ABCDEFGHIJ" } })).status()).toBe(403);
  expect((await r.put("/api/config/server", { data: { allowLan: true } })).status()).toBe(403);
  expect((await r.get("/api/debrid?action=torrents")).status()).toBe(403);
  expect((await r.post("/api/debrid", { data: { action: "addMagnet", magnet: "magnet:?xt=urn:btih:0" } })).status()).toBe(403);
  expect((await r.get("/api/admin/users")).status()).toBe(403);
  // Setup cannot be re-run by anyone once the server is initialized.
  expect((await r.post("/api/setup/unlock", { data: { code: "AAAA-BBBB-CCCC" } })).status()).toBe(409);
  expect((await r.post("/api/setup/owner", { data: { name: "x-owner", password: PASSWORD, confirm: PASSWORD } })).status()).toBe(409);

  // The playback configuration a member needs is readable, without any credential.
  const config = await (await r.get("/api/settings/sync")).json();
  expect(config.canManageServer).toBe(false);
  expect(JSON.stringify(config)).not.toMatch(/token|apiKey/i);

  // The UI matches: server sections are replaced by a notice, no Debrid link.
  await page.goto("/settings");
  await expect(page.getByTestId("server-settings-locked")).toBeVisible();
  await expect(page.getByTestId("debrid-settings")).toHaveCount(0);
  await expect(page.getByTestId("account-role")).toHaveText("Member");
  await page.goto("/browse");
  await expect(page.getByRole("link", { name: "Debrid" })).toHaveCount(0);

  // Members can still manage their own preferences.
  expect((await r.put("/api/user/state", { data: { action: "setPreferences", preferences: { autoplayNextEpisode: false } } })).ok()).toBe(true);
});

test("owner, administrator role and password reset", async ({ page, browser, baseURL }) => {
  test.skip(!DATA, "E2E_DATA_PATH (the test server's data folder) is needed to recover the owner offline");
  const cli = (...args: string[]) => execFileSync(process.execPath, ["scripts/notflix-cli.mjs", "--data-dir", DATA!, ...args], { encoding: "utf8" });
  const owner = (JSON.parse(fs.readFileSync(path.join(DATA!, "db", "users.json"), "utf8")).users as Array<{ name: string; role?: string }>).find((u) => u.role === "owner")!;
  // Offline recovery with the CLI (what an owner who forgot the password would do).
  const ownerPassword = /Temporary password for \S+: (\S+)/.exec(cli("accounts", "reset-password", owner.name))![1];
  expect(cli("accounts", "list")).toMatch(new RegExp(`${owner.name}\\s+owner`));
  // The test server's owner was created without a display name, so its first profile is "Main".
  await signInThroughUi(page, owner.name, ownerPassword);

  // The owner sees server settings and account administration.
  await page.goto("/settings");
  await expect(page.getByTestId("debrid-settings")).toBeVisible();
  await expect(page.getByTestId("accounts-admin")).toBeVisible();
  const ownerConfig = await (await page.request.get("/api/settings/sync")).json();
  expect(ownerConfig.canManageServer).toBe(true);

  // Promote a member to administrator; the admin manages accounts but not server settings or roles.
  const adminName = uniqueName("e2e-admin");
  const memberName = uniqueName("e2e-plain");
  const adminCtx = await browser.newContext({ baseURL });
  const memberCtx = await browser.newContext({ baseURL });
  await adminCtx.request.post("/api/auth/signup", { data: { name: adminName, password: PASSWORD } });
  await memberCtx.request.post("/api/auth/signup", { data: { name: memberName, password: PASSWORD } });
  await page.reload();
  const adminRow = page.locator(`[data-testid=account-row][data-account="${adminName}"]`);
  await adminRow.getByRole("button", { name: "Make admin" }).click();
  await expect(page.getByTestId("accounts-notice")).toContainText(`${adminName} is now an administrator`);
  expect((await adminCtx.request.post("/api/settings/sync", { data: {} })).status()).toBe(403);
  expect((await adminCtx.request.get("/api/config/debrid")).status()).toBe(403);
  const list = await (await adminCtx.request.get("/api/admin/users")).json();
  const memberId = list.users.find((u: { name: string }) => u.name === memberName).id;
  expect((await adminCtx.request.post("/api/admin/users", { data: { action: "setRole", userId: memberId, role: "admin" } })).status()).toBe(403);

  // Account recovery: the owner resets a member's password; the temporary one works, the old one does not.
  page.once("dialog", (d) => void d.accept());
  await page.locator(`[data-testid=account-row][data-account="${memberName}"]`).getByRole("button", { name: "Reset password" }).click();
  const notice = await page.getByTestId("accounts-notice").textContent();
  const temporary = /: (\S+) — share/.exec(notice ?? "")![1];
  expect((await memberCtx.request.get("/api/auth/me")).status()).toBe(401); // signed out everywhere
  expect((await memberCtx.request.post("/api/auth/login", { data: { name: memberName, password: PASSWORD } })).status()).toBe(401);
  expect((await memberCtx.request.post("/api/auth/login", { data: { name: memberName, password: temporary } })).status()).toBe(200);
  await adminCtx.close();
  await memberCtx.close();
});

test("kids profile: catalog, details and playback restricted on the server", async ({ page, request }) => {
  test.setTimeout(180_000);
  const name = uniqueName("e2e-kids");
  await createAccount(request, name, PASSWORD);
  await signInThroughUi(page, name, PASSWORD, "Kids");
  const r = page.request;

  for (const q of ["type=trending_day", "type=popular", "type=genre&g=animation&media=all", "type=genre&g=comedy&media=tv", "type=search&q=toy%20story", "type=search&q=deadpool"]) {
    const data = await (await r.get(`/api/catalog?${q}`)).json();
    expect(data.maturity, q).toBe("kids");
    for (const item of data.items) expect(KIDS_RATINGS.has(item.certification), `${q}: ${item.title} [${item.certification}]`).toBe(true);
    if (q.includes("animation") || q.includes("toy")) expect(data.items.length, q).toBeGreaterThan(3);
    if (q.includes("deadpool")) expect(data.items.some((i: { title: string }) => /^Deadpool( 2)?$/.test(i.title))).toBe(false);
  }
  // R-rated Deadpool (TMDB 293660): no details, no release search, no playback, no legacy routes.
  expect((await r.get("/api/catalog?type=title&id=293660&media=movie")).status()).toBe(403);
  expect((await r.get("/api/playback/sources?tmdbId=293660&type=movie")).status()).toBe(403);
  expect((await r.post("/api/playback/start", { data: { tmdbId: 293660, type: "movie" } })).status()).toBe(403);
  expect((await r.post("/api/playback/start", { data: { title: "Deadpool", type: "movie" } })).status()).toBe(403); // unverifiable
  expect((await r.get("/api/play/resolve?tmdbId=293660&type=movie")).status()).toBe(403);
  // G-rated Toy Story (862) is allowed.
  expect((await r.get("/api/catalog?type=title&id=862&media=movie")).status()).toBe(200);

  // The UI shows only kid-safe titles in search.
  await page.goto("/browse/search");
  await page.getByPlaceholder("Titles, people, genres").fill("Deadpool");
  await page.waitForTimeout(2500);
  await expect(page.getByRole("button", { name: /^Deadpool \(2016\)/ })).toHaveCount(0);

  // A kids profile cannot add profiles or loosen its own restrictions.
  const me = await profilesOf(page);
  const kids = me.find((p) => p.name === "Kids")!;
  expect((await r.post("/api/user/profiles", { data: { action: "create", name: "Grown-up", isKids: false } })).status()).toBe(403);
  expect((await r.post("/api/user/profiles", { data: { action: "restrictions", profileId: kids.id, isKids: false, maturity: "all" } })).status()).toBe(403);
  expect((await r.post("/api/user/profiles", { data: { action: "restrictions", profileId: kids.id, isKids: false, maturity: "all", password: "guess-123" } })).status()).toBe(403);
  // Leaving the profile does not widen anything: without a profile the strictest level applies,
  // and creating an unrestricted profile then needs the account password.
  expect((await r.post("/api/user/profiles", { data: { action: "leave" } })).ok()).toBe(true);
  expect((await (await r.get("/api/auth/me")).json()).maturity).toBe("kids");
  expect((await (await r.get("/api/catalog?type=popular")).json()).maturity).toBe("kids");
  expect((await r.post("/api/user/profiles", { data: { action: "create", name: "Grown-up", isKids: false } })).status()).toBe(403);
  // Opening the details of a restricted title from the UI shows a clear message.
  await r.post("/api/user/profiles", { data: { action: "select", profileId: kids.id } });
  await page.goto("/browse/search");
  await page.getByPlaceholder("Titles, people, genres").fill("Toy Story");
  await page.getByRole("button", { name: /^Toy Story \(1995\)/ }).click();
  await expect(page.getByTestId("details-certification")).toHaveText("G");
});

test("teens maturity level on an adult profile needs the account password", async ({ page, request }) => {
  const name = uniqueName("e2e-teen");
  await createAccount(request, name, PASSWORD);
  await signInThroughUi(page, name, PASSWORD);
  const main = (await profilesOf(page)).find((p) => p.name === "Main")!;
  const r = page.request;
  expect((await r.post("/api/user/profiles", { data: { action: "restrictions", profileId: main.id, isKids: false, maturity: "teens" } })).status()).toBe(403);
  expect((await r.post("/api/user/profiles", { data: { action: "restrictions", profileId: main.id, isKids: false, maturity: "teens", password: PASSWORD } })).ok()).toBe(true);
  const data = await (await r.get("/api/catalog?type=genre&g=action&media=movie")).json();
  expect(data.maturity).toBe("teens");
  for (const item of data.items) expect(["G", "PG", "PG-13"]).toContain(item.certification);
  expect((await r.get("/api/catalog?type=title&id=293660&media=movie")).status()).toBe(403); // R
});
