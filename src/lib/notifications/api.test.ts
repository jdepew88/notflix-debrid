/**
 * Notification API through the real route handlers (fresh data folder, no network): sign-in and
 * profile required, per-profile isolation, cross-site requests refused, push subscription checks,
 * owner-only job status; plus an existing installation gaining notifications without losing
 * accounts, profiles, history or credentials.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notflix-notify-api-"));
process.env.NOTFLIX_DATA_DIR = dataDir;
process.env.NOTFLIX_NOTIFICATIONS = "0";
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

let currentCookies = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (currentCookies.has(name) ? { name, value: currentCookies.get(name)! } : undefined) }),
}));

type Jar = Map<string, string>;
function request(url: string, init: { method?: string; body?: unknown; jar?: Jar; headers?: Record<string, string> } = {}) {
  const jar = init.jar ?? new Map();
  currentCookies = jar;
  const headers = new Headers({ "content-type": "application/json", "x-notflix-peer": "127.0.0.1", host: "localhost:8420", ...init.headers });
  return new NextRequest(new URL(url, "http://localhost:8420"), { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

let routes: {
  list: typeof import("@/app/api/notifications/route");
  follow: typeof import("@/app/api/notifications/follow/route");
  push: typeof import("@/app/api/notifications/push/route");
  status: typeof import("@/app/api/notifications/status/route");
};
let store: typeof import("./store");
let dir: string;
const people: Record<string, { jar: Jar; userId: string; profiles: string[] }> = {};

async function signIn(userId: string, version: number, profileId: string | null): Promise<Jar> {
  const { createSessionToken, createProfileToken, SESSION_COOKIE, PROFILE_COOKIE } = await import("@/lib/session");
  const jar: Jar = new Map([[SESSION_COOKIE, await createSessionToken(userId, { version })]]);
  if (profileId) jar.set(PROFILE_COOKIE, await createProfileToken(userId, profileId));
  return jar;
}

beforeAll(async () => {
  const { initializeInstall } = await import("../install/init.mjs");
  initializeInstall(dataDir);
  const { updateServerConfig } = await import("../install/config.mjs");
  updateServerConfig(dataDir, (c) => {
    c.setup.completed = true;
  });
  const users = await import("@/lib/users");
  const owner = await users.createOwner("owner", "owner-password-1");
  const member = await users.createUser("member", "member-password-1");
  for (const [name, u] of [["owner", owner], ["member", member]] as const) {
    const profiles = users.readUserState(u.id).profiles.map((p) => p.id);
    people[name] = { userId: u.id, profiles, jar: await signIn(u.id, 0, profiles[0]) };
  }
  routes = {
    list: await import("@/app/api/notifications/route"),
    follow: await import("@/app/api/notifications/follow/route"),
    push: await import("@/app/api/notifications/push/route"),
    status: await import("@/app/api/notifications/status/route"),
  };
  store = await import("./store");
  dir = (await import("./server")).notificationsDir();
});

const sample = (key: string) => ({ dedupeKey: key, type: "new-episode" as const, category: "episodes" as const, title: `Title ${key}`, body: "<b>not html</b>", url: "/browse?title=tmdb-tv-1", source: "tmdb" as const, priority: "normal" as const, ttlDays: 30 });

describe("notification API", () => {
  it("requires sign-in and a chosen profile", async () => {
    expect((await routes.list.GET(request("/api/notifications"))).status).toBe(401);
    const noProfile = await signIn(people.member.userId, 0, null);
    expect((await routes.list.GET(request("/api/notifications", { jar: noProfile }))).status).toBe(409);
  });

  it("returns only the requesting profile's notifications and refuses changes to others'", async () => {
    const m = people.member;
    store.deliver(dir, m.userId, m.profiles[0], [sample("a"), sample("b")], { now: new Date(), enabled: () => true });
    store.deliver(dir, m.userId, m.profiles[1], [sample("kids")], { now: new Date(), enabled: () => true });
    const res = await routes.list.GET(request("/api/notifications", { jar: m.jar }));
    const page = await res.json();
    expect(page.items.map((i: { title: string }) => i.title)).toEqual(["Title b", "Title a"]);
    expect(page.unread).toBe(2);
    // Text is returned as data (React escapes it on render).
    expect(page.items[0].body).toBe("<b>not html</b>");
    expect((await (await routes.list.GET(request("/api/notifications?count=1", { jar: m.jar }))).json()).unread).toBe(2);

    // Another account, and the member's other profile, cannot touch these ids.
    const ids = page.items.map((i: { id: string }) => i.id);
    const ownerRes = await routes.list.POST(request("/api/notifications", { method: "POST", jar: people.owner.jar, body: { action: "dismiss", ids } }));
    expect((await ownerRes.json()).changed).toBe(0);
    const kidsJar = await signIn(m.userId, 0, m.profiles[1]);
    expect((await (await routes.list.POST(request("/api/notifications", { method: "POST", jar: kidsJar, body: { action: "read", ids } }))).json()).changed).toBe(0);
    const kidsPage = await (await routes.list.GET(request("/api/notifications", { jar: kidsJar }))).json();
    expect(kidsPage.items.map((i: { title: string }) => i.title)).toEqual(["Title kids"]);

    const read = await routes.list.POST(request("/api/notifications", { method: "POST", jar: m.jar, body: { action: "read", ids: [ids[0]] } }));
    expect(await read.json()).toEqual({ changed: 1, unread: 1 });
    const all = await routes.list.POST(request("/api/notifications", { method: "POST", jar: m.jar, body: { action: "read-all" } }));
    expect((await all.json()).unread).toBe(0);
  });

  it("refuses cross-site requests and non-JSON bodies", async () => {
    const m = people.member;
    const cross = await routes.list.POST(request("/api/notifications", { method: "POST", jar: m.jar, body: { action: "read-all" }, headers: { "sec-fetch-site": "cross-site" } }));
    expect(cross.status).toBe(403);
    const foreignOrigin = await routes.list.POST(request("/api/notifications", { method: "POST", jar: m.jar, body: { action: "read-all" }, headers: { origin: "https://evil.example" } }));
    expect(foreignOrigin.status).toBe(403);
    const sameOrigin = await routes.list.POST(request("/api/notifications", { method: "POST", jar: m.jar, body: { action: "read-all" }, headers: { origin: "http://localhost:8420", "sec-fetch-site": "same-origin" } }));
    expect(sameOrigin.status).toBe(200);
    const form = await routes.list.POST(request("/api/notifications", { method: "POST", jar: m.jar, body: { action: "read-all" }, headers: { "content-type": "text/plain" } }));
    expect(form.status).toBe(415);
    const bad = await routes.list.POST(request("/api/notifications", { method: "POST", jar: m.jar, body: { action: "delete-everything" } }));
    expect(bad.status).toBe(400);
  });

  it("follows and unfollows a series for the profile in use", async () => {
    const m = people.member;
    const get = async () => (await routes.follow.GET(request("/api/notifications/follow?tmdbId=42", { jar: m.jar }))).json();
    expect(await get()).toMatchObject({ following: false, source: null });
    expect((await routes.follow.POST(request("/api/notifications/follow", { method: "POST", jar: m.jar, body: { tmdbId: 42, follow: true, title: "Show" } }))).status).toBe(200);
    expect(await get()).toMatchObject({ following: true, source: "explicit" });
    await routes.follow.POST(request("/api/notifications/follow", { method: "POST", jar: m.jar, body: { tmdbId: 42, follow: false } }));
    expect(await get()).toMatchObject({ following: false, muted: true });
    expect((await routes.follow.POST(request("/api/notifications/follow", { method: "POST", jar: m.jar, body: { tmdbId: "42; rm", follow: true } }))).status).toBe(400);
  });

  it("registers and removes push subscriptions; serves only the public VAPID key", async () => {
    const m = people.member;
    const info = await (await routes.push.GET(request("/api/notifications/push", { jar: m.jar }))).json();
    expect(Buffer.from(info.publicKey, "base64url")).toHaveLength(65);
    expect(JSON.stringify(info)).not.toMatch(/private/i);
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/test-device", keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };
    const ssrf = await routes.push.POST(request("/api/notifications/push", { method: "POST", jar: m.jar, body: { subscription: { ...subscription, endpoint: "https://192.168.1.1/admin" } } }));
    expect(ssrf.status).toBe(400);
    expect((await routes.push.POST(request("/api/notifications/push", { method: "POST", jar: m.jar, body: { subscription: { ...subscription, keys: { p256dh: "x", auth: "y" } } } }))).status).toBe(400);
    expect((await routes.push.POST(request("/api/notifications/push", { method: "POST", jar: m.jar, body: { subscription, label: "Chrome on Windows" } }))).status).toBe(200);
    const mine = await (await routes.push.GET(request(`/api/notifications/push?endpoint=${encodeURIComponent(subscription.endpoint)}`, { jar: m.jar }))).json();
    expect(mine).toMatchObject({ subscriptions: 1, thisBrowser: true });
    // Another account cannot remove it.
    const other = await routes.push.DELETE(request("/api/notifications/push", { method: "DELETE", jar: people.owner.jar, body: { endpoint: subscription.endpoint } }));
    expect(await other.json()).toEqual({ removed: false });
    const own = await routes.push.DELETE(request("/api/notifications/push", { method: "DELETE", jar: m.jar, body: { endpoint: subscription.endpoint } }));
    expect(await own.json()).toEqual({ removed: true });
  });

  it("shows job status to the owner only", async () => {
    currentCookies = new Map();
    expect((await routes.status.GET()).status).toBe(401);
    currentCookies = people.member.jar;
    expect((await routes.status.GET()).status).toBe(403);
    currentCookies = people.owner.jar;
    const res = await routes.status.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.jobs)).toEqual(["series", "releases", "trending", "recommendations", "service", "cleanup"]);
  });
});

describe("existing installation", () => {
  it("adds notifications without changing accounts, profiles, history or stored credentials", async () => {
    const users = await import("@/lib/users");
    const { readSecrets, updateSecrets } = await import("../install/secrets.mjs");
    updateSecrets(dataDir, { tmdbApiKey: "SIMULATEDTMDBKEY0123456789abcdef", realDebridToken: "SIMULATEDRDTOKEN0000000000000000" });
    const m = people.member;
    // A profile state written by an older version: no notification preferences at all.
    const state = users.readUserState(m.userId);
    state.myListByProfile[m.profiles[0]] = ["tmdb-tv-1399", "tmdb-603"];
    state.lastWatchedByProfile = { [m.profiles[0]]: { "tmdb-tv-1399": { progress: 40, updatedAt: Date.now(), season: 1, episode: 2 } } };
    state.preferencesByProfile = { [m.profiles[0]]: { audioLanguage: "de" } as never };
    users.writeUserState(m.userId, state);
    const before = fs.readFileSync(path.join(dataDir, "db", "users.json"), "utf8");

    const { accountViews, vapidKeys } = await import("./server");
    const views = accountViews();
    const view = views.find((v) => v.id === m.userId)!.profiles.find((p) => p.id === m.profiles[0])!;
    expect(view.prefs).toMatchObject({ episodes: true, physical: false, browser: false });
    expect(view.myList).toEqual(["tmdb-tv-1399", "tmdb-603"]);
    expect(view.watched[0]).toMatchObject({ tmdbId: 1399, mediaType: "tv" });
    expect(users.getProfilePreferences(m.userId, m.profiles[0]).audioLanguage).toBe("de");

    // VAPID keys join the encrypted store; nothing else in it changes.
    const keys = vapidKeys();
    const secrets = readSecrets(dataDir);
    expect(secrets.vapidPublicKey).toBe(keys.publicKey);
    expect(secrets.tmdbApiKey).toBe("SIMULATEDTMDBKEY0123456789abcdef");
    expect(secrets.realDebridToken).toBe("SIMULATEDRDTOKEN0000000000000000");
    expect(fs.readFileSync(path.join(dataDir, "secrets", "secrets.json"), "utf8")).not.toContain(keys.privateKey);
    expect(fs.readFileSync(path.join(dataDir, "db", "users.json"), "utf8")).toBe(before);

    // Notification preferences are saved per profile through the existing preference store.
    users.updateProfilePreferences(m.userId, m.profiles[0], { notifications: { physical: true, region: "GB" } });
    expect(users.getProfilePreferences(m.userId, m.profiles[0]).notifications).toMatchObject({ physical: true, region: "GB", episodes: true });
    expect(users.getProfilePreferences(m.userId, m.profiles[1]).notifications.physical).toBe(false);
    expect(users.getProfilePreferences(m.userId, m.profiles[0]).audioLanguage).toBe("de");
  });
});
