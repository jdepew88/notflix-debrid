import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createAccount, profilesOf, signInThroughUi, uniqueName } from "./helpers";
import { deliver } from "../src/lib/notifications/store";
import type { NotificationContent } from "../src/lib/notifications/types";

/**
 * Notification center and browser notifications in real Chrome against the test instance.
 * Notifications are seeded straight into the instance's data folder (E2E_DATA_PATH), as the
 * background jobs would deliver them; the jobs themselves are covered by the unit tests with
 * mocked TMDB answers.
 */
const PASSWORD = "e2e-pass-8";

function notificationsDir(): string {
  const data = process.env.E2E_DATA_PATH;
  if (!data) throw new Error("E2E_DATA_PATH is required (the test instance's data folder)");
  return path.join(data, "db", "notifications");
}

const episode = (n: number, over: Partial<NotificationContent> = {}): NotificationContent => ({
  dedupeKey: `ep:1399:1:${n}`,
  type: "new-episode",
  category: "episodes",
  tmdbId: 1399,
  mediaType: "tv",
  season: 1,
  episode: n,
  name: "Game of Thrones",
  title: `Game of Thrones: new episode ${n}`,
  body: `S1 E${n} is out.`,
  image: "/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg",
  url: "/browse?title=tmdb-tv-1399&season=1",
  source: "tmdb",
  priority: "normal",
  certification: "TV-MA",
  ttlDays: 30,
  ...over,
});

async function seed(accountId: string, profileId: string, items: NotificationContent[]) {
  deliver(notificationsDir(), accountId, profileId, items, { now: new Date(), enabled: () => true, limits: { episodes: 1000, seasons: 1000, digital: 1000, physical: 1000, trending: 1000, recommendations: 1000, service: 1000 } });
}

async function signedIn(page: Page, request: Parameters<typeof createAccount>[0]) {
  const name = uniqueName("e2e-notify");
  await createAccount(request, name, PASSWORD);
  await signInThroughUi(page, name, PASSWORD);
  const me = await (await page.request.get("/api/auth/me")).json();
  const profiles = await profilesOf(page);
  return { accountId: me.user.id as string, main: profiles.find((p) => p.name === "Main")!.id, kids: profiles.find((p) => p.isKids)!.id };
}

const bell = (page: Page) => page.getByTestId("notification-bell");
const panel = (page: Page) => page.getByTestId("notification-panel");

test("bell, popover, read/unread, dismiss, mark all, keyboard and persistence", async ({ page, request }) => {
  const who = await signedIn(page, request);
  await seed(who.accountId, who.main, [episode(1), episode(2), episode(3), episode(4, { type: "service", category: "service", title: "Notflix needs attention", body: "Check the settings.", url: "/settings#notifications", tmdbId: undefined, image: undefined })]);
  await page.goto("/browse");
  await expect(page.getByTestId("notification-badge")).toHaveText("4");
  await expect(bell(page)).toHaveAttribute("aria-label", "Notifications, 4 unread");

  await bell(page).click();
  await expect(panel(page)).toBeVisible();
  const items = panel(page).getByTestId("notification-item");
  await expect(items).toHaveCount(4);
  await expect(items.first()).toContainText("Notflix needs attention");
  await expect(items.nth(1).locator("img")).toHaveAttribute("src", /image\.tmdb\.org\/t\/p\/w185\//);
  await expect(items.nth(1)).toContainText(/ago|now/);
  // Keyboard: focus starts on the first notification; arrows move; Escape closes and returns focus.
  await expect(items.first().locator("[data-notification-link]")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1).locator("[data-notification-link]")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(bell(page)).toBeFocused();

  await bell(page).click();
  await items.nth(1).getByTestId("notification-toggle-read").click();
  await expect(items.nth(1)).toHaveAttribute("data-unread", "false");
  await expect(page.getByTestId("notification-badge")).toHaveText("3");
  await items.nth(2).getByTestId("notification-dismiss").click();
  await expect(items).toHaveCount(3);
  await page.reload();
  await expect(page.getByTestId("notification-badge")).toHaveText("2");
  await bell(page).click();
  await expect(panel(page).getByTestId("notification-item")).toHaveCount(3);
  await page.getByTestId("notifications-read-all").click();
  await expect(page.getByTestId("notification-badge")).toHaveCount(0);
  await expect(bell(page)).toHaveAttribute("aria-label", "Notifications");

  // A service notification opens its settings page.
  await panel(page).getByTestId("notification-item").first().locator("[data-notification-link]").click();
  await page.waitForURL(/\/settings#notifications/);
  await expect(page.getByTestId("notification-settings")).toBeVisible();
});

test("a title notification opens its details; deep links open details and clean the address", async ({ page, request }) => {
  const who = await signedIn(page, request);
  await seed(who.accountId, who.main, [episode(5)]);
  await page.goto("/browse");
  await bell(page).click();
  await panel(page).getByTestId("notification-item").first().locator("[data-notification-link]").click();
  await expect(page.getByTestId("title-details")).toBeVisible();
  await expect(page.getByTestId("notification-badge")).toHaveCount(0); // opening marks it read
  await page.getByTestId("details-close").click();

  await page.goto("/browse?title=tmdb-603");
  await expect(page.getByTestId("title-details")).toBeVisible();
  await expect(page).toHaveURL(/\/browse$/);
});

test("empty, loading-error and profile-specific states; notification history pages", async ({ page, request }) => {
  const who = await signedIn(page, request);
  await page.goto("/browse");
  await bell(page).click();
  await expect(page.getByTestId("notifications-empty")).toBeVisible();
  await page.keyboard.press("Escape");

  // Errors are shown with a retry, not as an empty list.
  await page.route("**/api/notifications?limit=8*", (route) => route.fulfill({ status: 500, body: "{}" }));
  await bell(page).click();
  await expect(panel(page).getByRole("alert")).toContainText("could not be loaded");
  await page.unroute("**/api/notifications?limit=8*");
  await panel(page).getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("notifications-empty")).toBeVisible();
  await page.keyboard.press("Escape");

  // 30 notifications for Main only.
  await seed(who.accountId, who.main, Array.from({ length: 30 }, (_, i) => episode(100 + i)));
  await page.goto("/browse/notifications");
  await expect(page.getByTestId("notification-item")).toHaveCount(25);
  await page.getByTestId("notifications-more").click();
  await expect(page.getByTestId("notification-item")).toHaveCount(30);
  await expect(page.getByTestId("notifications-more")).toHaveCount(0);
  await page.getByRole("button", { name: /Unread/ }).click();
  await expect(page.getByTestId("notification-item")).toHaveCount(25);

  // The Kids profile sees none of Main's notifications.
  const res = await page.request.post("/api/user/profiles", { data: { action: "select", profileId: who.kids } });
  expect(res.ok()).toBe(true);
  await page.goto("/browse/notifications");
  await expect(page.getByTestId("notifications-empty")).toBeVisible();
});

test("notification preferences are saved per profile", async ({ page, request }) => {
  const who = await signedIn(page, request);
  await page.goto("/settings#notifications");
  const physical = page.getByTestId("notify-physical");
  await expect(physical).not.toBeChecked();
  await physical.check();
  await page.getByTestId("notify-region").selectOption("GB");
  await expect.poll(async () => (await (await page.request.get("/api/user/state")).json()).state.preferencesByProfile?.[who.main]?.notifications?.region).toBe("GB");
  await page.reload();
  await expect(page.getByTestId("notify-physical")).toBeChecked();
  await expect(page.getByTestId("notify-region")).toHaveValue("GB");
  await page.request.post("/api/user/profiles", { data: { action: "select", profileId: who.kids } });
  await page.reload();
  await expect(page.getByTestId("notify-physical")).not.toBeChecked();
  await expect(page.getByTestId("notify-browser")).not.toBeChecked(); // off by default
});

/** Counts permission prompts and native notifications the page creates. */
async function instrument(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as { __prompts: number; __shown: string[] };
    w.__prompts = 0;
    w.__shown = [];
    if (!("Notification" in window)) return;
    const Original = window.Notification;
    const request = Original.requestPermission.bind(Original);
    class Counting extends Original {
      constructor(title: string, options?: NotificationOptions) {
        super(title, options);
        w.__shown.push(title);
      }
    }
    Object.defineProperty(Counting, "permission", { get: () => Original.permission });
    Counting.requestPermission = (...args: Parameters<typeof Original.requestPermission>) => {
      w.__prompts++;
      return request(...args);
    };
    window.Notification = Counting as typeof Notification;
  });
}

test("browser notifications: enable with permission, service worker, push delivery, revocation", async ({ page, context, request, baseURL }) => {
  await instrument(context);
  const who = await signedIn(page, request);
  await context.grantPermissions(["notifications"], { origin: baseURL! });
  await page.goto("/settings#notifications");
  await expect(page.getByTestId("browser-notify-state")).toContainText("allowed");
  // A click, not check(): the switch turns on only after the browser's permission is confirmed.
  await page.getByTestId("notify-browser").click();
  await expect(page.getByTestId("notify-browser")).toBeChecked();
  await expect(page.getByTestId("notification-settings")).toContainText(/Browser notifications are on|appear while Notflix is open/);
  // Already granted: no prompt was shown.
  expect(await page.evaluate(() => (window as unknown as { __prompts: number }).__prompts)).toBe(0);

  const sw = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/"))?.active?.scriptURL ?? null);
  expect(sw).toMatch(/\/notflix-sw\.js$/);
  const push = await (await page.request.get("/api/notifications/push")).json();
  const pushActive = push.subscriptions > 0;
  test.info().annotations.push({ type: "push", description: pushActive ? "Web Push subscription registered (push service reachable)" : "Push service unavailable in this browser; foreground notifications only" });

  // A push message (delivered through Chrome's DevTools protocol, as a push service would) is shown
  // by the service worker with the notification's title and link.
  const cdp = await context.newCDPSession(page);
  const origin = new URL(baseURL!).origin;
  let registrationId = "";
  let running = false;
  cdp.on("ServiceWorker.workerRegistrationUpdated", (e: { registrations: Array<{ registrationId: string; scopeURL: string }> }) => {
    registrationId = e.registrations.find((x) => x.scopeURL.startsWith(origin))?.registrationId ?? registrationId;
  });
  cdp.on("ServiceWorker.workerVersionUpdated", (e: { versions: Array<{ registrationId: string; status: string; runningStatus: string }> }) => {
    const v = e.versions.find((x) => x.registrationId === registrationId);
    if (v) running = v.status === "activated" && v.runningStatus === "running";
  });
  await cdp.send("ServiceWorker.enable");
  await expect.poll(() => running, { timeout: 15_000 }).toBe(true);
  const shown = () =>
    page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration("/"))!.getNotifications()).map((n) => ({ title: n.title, url: (n.data as { url: string }).url })));
  // DevTools may restart the worker while attaching; a message delivered during that is lost, so retry.
  await expect(async () => {
    await cdp.send("ServiceWorker.deliverPushMessage", {
      origin,
      registrationId,
      data: JSON.stringify({ title: "Pushed: new episode", body: "S1 E9 is out.", url: "/browse?title=tmdb-tv-1399&season=1", tag: "e2e-push" }),
    });
    await expect.poll(shown, { timeout: 3_000 }).toContainEqual({ title: "Pushed: new episode", url: "/browse?title=tmdb-tv-1399&season=1" });
  }).toPass({ timeout: 20_000 });

  if (!pushActive) {
    // Without background push, new notifications are shown while Notflix is open.
    await page.goto("/browse");
    await page.waitForTimeout(500);
    await seed(who.accountId, who.main, [episode(42, { title: "Shown in the foreground" })]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shown: string[] }).__shown)).toContain("Shown in the foreground");
    await page.goto("/settings#notifications");
  }

  // The user withdraws the permission in the browser: Notflix notices, shows it, removes the
  // subscription, keeps in-app notifications and does not prompt.
  await context.clearPermissions();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByTestId("browser-notify-state")).toContainText(/not asked yet|blocked/);
  await expect(page.getByTestId("notify-browser")).not.toBeChecked();
  await expect.poll(async () => (await (await page.request.get("/api/notifications/push")).json()).subscriptions).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __prompts: number }).__prompts)).toBe(0);
  await page.goto("/browse");
  await expect(bell(page)).toBeVisible();
});

test("browser notifications: a refused permission is explained and never requested again", async ({ page, context, request }) => {
  await instrument(context);
  await signedIn(page, request);
  await page.goto("/settings#notifications");
  await expect(page.getByTestId("browser-notify-state")).toContainText("not asked yet");
  // Headless Chrome answers permission requests without a user present (refused or dismissed).
  await page.getByTestId("notify-browser").click();
  await expect(page.getByTestId("notification-settings")).toContainText(/blocks notifications|closed the browser's question/);
  await expect(page.getByTestId("notify-browser")).not.toBeChecked();
  expect(await page.evaluate(() => (window as unknown as { __prompts: number }).__prompts)).toBe(1);
  const state = await page.evaluate(() => Notification.permission);
  await expect(page.getByTestId("notification-settings")).toContainText(state === "denied" ? /blocks notifications/ : /closed the browser's question/);
  if (state === "denied") {
    await page.getByTestId("notify-browser").click();
    await expect(page.getByTestId("notify-browser")).not.toBeChecked();
    expect(await page.evaluate(() => (window as unknown as { __prompts: number }).__prompts)).toBe(1);
  }
  const prefs = (await (await page.request.get("/api/user/state")).json()).state;
  const profileId = prefs.activeProfileId;
  expect(prefs.preferencesByProfile?.[profileId]?.notifications?.browser ?? false).toBe(false);
});
