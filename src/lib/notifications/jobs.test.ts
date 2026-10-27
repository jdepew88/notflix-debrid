/**
 * The real background jobs, store, scheduler and push dispatch against mocked TMDB answers, a fixed
 * clock and a throwaway folder: profile isolation, following, dedupe across runs, regions,
 * read/dismiss state, limits, maturity, retries, the cross-process lease, restarts and Web Push.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES, normalizeNotificationPreferences, type NotificationPreferences } from "./preferences";
import {
  JOBS,
  dispatchPushes,
  followedSeries,
  readState,
  runReleasesJob,
  runRecommendationsJob,
  runSeriesJob,
  runTrendingJob,
  updateState,
  type AccountView,
  type JobContext,
  type ProfileView,
} from "./jobs";
import { applyAction, deliver, listNotifications, readProfileInbox, setFollow, unreadCount } from "./store";
import { NotificationScheduler, acquireLease, backoffMs } from "./scheduler";
import { checkEndpoint, listSubscriptions, removeSubscription, saveSubscription } from "./subscriptions";
import { createTmdbClient } from "./tmdb-client";
import { decryptPayload, generateVapidKeys, verifyVapid } from "./webpush";
import type { MaturityLevel } from "../maturity";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "notflix-notify-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshDir = () => {
  const d = path.join(root, `case-${++n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

// --- Fake TMDB --------------------------------------------------------------------------------------

type Routes = Record<string, unknown>;
function fakeTmdb(routes: Routes) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    u.searchParams.delete("api_key");
    const key = u.pathname.replace(/^\/3/, "") + (u.search ? `?${decodeURIComponent(u.searchParams.toString())}` : "");
    calls.push(key);
    const hit = Object.entries(routes).find(([pattern]) => (pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : key === pattern));
    if (!hit) return new Response("{}", { status: 404 });
    const value = typeof hit[1] === "function" ? (hit[1] as () => unknown)() : hit[1];
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function profile(id: string, over: Partial<Omit<ProfileView, "prefs">> & { prefs?: Partial<NotificationPreferences> } = {}): ProfileView {
  return {
    id,
    name: id,
    isKids: false,
    maturity: "all" as MaturityLevel,
    myList: [],
    watched: [],
    ...over,
    prefs: normalizeNotificationPreferences({ region: "US", ...over.prefs }, DEFAULT_NOTIFICATION_PREFERENCES),
  };
}

function context(dir: string, accounts: AccountView[], routes: Routes, clock: { now: Date }): JobContext & { calls: string[] } {
  const { fetchImpl, calls } = fakeTmdb(routes);
  return {
    dir,
    now: () => clock.now,
    tmdb: createTmdbClient({ apiKey: "testkey0123456789abcdef", fetchImpl, minIntervalMs: 0, sleep: async () => {}, now: () => clock.now.getTime() }),
    accounts: () => accounts,
    log: () => {},
    calls,
  };
}

const tv = (id: number, lea: { s: number; e: number; date: string }, rating = "TV-14", seasons?: Array<{ n: number; date: string | null; count: number }>) => ({
  id,
  name: `Show ${id}`,
  poster_path: `/s${id}.jpg`,
  seasons: (seasons ?? [{ n: lea.s, date: "2026-01-01", count: 10 }]).map((s) => ({ season_number: s.n, episode_count: s.count, air_date: s.date })),
  last_episode_to_air: { season_number: lea.s, episode_number: lea.e, air_date: lea.date, name: `Ep ${lea.e}` },
  content_ratings: { results: [{ iso_3166_1: "US", rating }] },
});

// --- Store -----------------------------------------------------------------------------------------

describe("store: per-profile state", () => {
  const content = (key: string, over = {}) => ({
    dedupeKey: key,
    type: "new-episode" as const,
    category: "episodes" as const,
    title: `T ${key}`,
    body: "b",
    url: "/browse",
    source: "tmdb" as const,
    priority: "normal" as const,
    ttlDays: 60,
    ...over,
  });
  const opts = (now: Date) => ({ now, enabled: () => true });

  it("isolates profiles: one profile cannot read or change another's notifications", () => {
    const dir = freshDir();
    const now = new Date("2026-10-20T10:00:00Z");
    deliver(dir, "acct-a", "prof-1", [content("k1"), content("k2")], opts(now));
    deliver(dir, "acct-a", "prof-2", [content("k3")], opts(now));
    deliver(dir, "acct-b", "prof-9", [content("k1")], opts(now));
    const p1 = listNotifications(dir, "acct-a", "prof-1", { now });
    expect(p1.items.map((i) => i.title)).toEqual(["T k2", "T k1"]);
    expect(listNotifications(dir, "acct-a", "prof-2", { now }).items.map((i) => i.title)).toEqual(["T k3"]);
    // Ids of profile 1 used from profile 2 / account B change nothing.
    expect(applyAction(dir, "acct-a", "prof-2", "dismiss", p1.items.map((i) => i.id), now)).toBe(0);
    expect(applyAction(dir, "acct-b", "prof-9", "read", p1.items.map((i) => i.id), now)).toBe(0);
    expect(unreadCount(readProfileInbox(dir, "acct-a", "prof-1"), now)).toBe(2);
    // The same event for another account is a different notification.
    expect(listNotifications(dir, "acct-b", "prof-9", { now }).items[0].id).not.toBe(p1.items[1].id);
    // Internal fields never leave the server.
    expect(Object.keys(p1.items[0])).not.toContain("dedupeKey");
  });

  it("read, unread, dismiss, mark all, unread count and stable pagination", () => {
    const dir = freshDir();
    const now = new Date("2026-10-20T10:00:00Z");
    deliver(dir, "a", "p", Array.from({ length: 7 }, (_, i) => content(`k${i}`)), opts(now));
    const first = listNotifications(dir, "a", "p", { limit: 3, now });
    expect(first.items).toHaveLength(3);
    expect(first.unread).toBe(7);
    deliver(dir, "a", "p", [content("newer")], opts(now)); // arrives between page requests
    const second = listNotifications(dir, "a", "p", { limit: 3, cursor: first.nextCursor, now });
    expect(second.items.map((i) => i.title)).toEqual(["T k3", "T k2", "T k1"]);
    expect(applyAction(dir, "a", "p", "read", [first.items[0].id], now)).toBe(1);
    expect(applyAction(dir, "a", "p", "read", [first.items[0].id], now)).toBe(0);
    expect(applyAction(dir, "a", "p", "unread", [first.items[0].id], now)).toBe(1);
    expect(applyAction(dir, "a", "p", "dismiss", [first.items[1].id], now)).toBe(1);
    const after = listNotifications(dir, "a", "p", { limit: 50, now });
    expect(after.items.map((i) => i.id)).not.toContain(first.items[1].id);
    expect(after.unread).toBe(7);
    expect(applyAction(dir, "a", "p", "read-all", [], now)).toBe(7);
    expect(listNotifications(dir, "a", "p", { unreadOnly: true, now }).items).toEqual([]);
  });

  it("never adds the same event twice, applies daily limits, and keeps disabled categories re-announceable", () => {
    const dir = freshDir();
    const now = new Date("2026-10-20T10:00:00Z");
    expect(deliver(dir, "a", "p", [content("k1"), content("k1")], opts(now)).delivered).toHaveLength(1);
    expect(deliver(dir, "a", "p", [content("k1")], opts(now)).duplicates).toBe(1);
    const trending = Array.from({ length: 6 }, (_, i) => content(`t${i}`, { category: "trending", type: "trending" }));
    expect(deliver(dir, "a", "p", trending, opts(now)).delivered).toHaveLength(3);
    const off = deliver(dir, "a", "p", [content("s1", { category: "seasons" })], { now, enabled: (c) => c !== "seasons" });
    expect(off.disabled).toBe(1);
    expect(deliver(dir, "a", "p", [content("s1", { category: "seasons" })], opts(now)).delivered).toHaveLength(1);
    // Expired notifications disappear from the center.
    expect(listNotifications(dir, "a", "p", { now: new Date("2027-01-01T00:00:00Z") }).items).toEqual([]);
  });
});

// --- Jobs ------------------------------------------------------------------------------------------

describe("series job", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });

  it("follows My List, recent watching and explicit follows, minus unfollowed series", () => {
    const now = new Date("2026-10-20T10:00:00Z");
    const p = profile("p1", {
      myList: ["tmdb-tv-1", "tmdb-55", "tmdb-tv-2"],
      watched: [
        { tmdbId: 3, mediaType: "tv", title: "Recent", at: now.getTime() - 86_400_000 },
        { tmdbId: 4, mediaType: "tv", title: "Long ago", at: now.getTime() - 300 * 86_400_000 },
        { tmdbId: 9, mediaType: "movie", title: "Film", at: now.getTime() },
      ],
    });
    setFollow(dir, "a", "p1", 5, true, "Explicit", now);
    setFollow(dir, "a", "p1", 2, false, undefined, now);
    expect([...followedSeries(p, readProfileInbox(dir, "a", "p1"), now).keys()].sort()).toEqual([1, 3, 5]);
  });

  it("notifies followers of a new episode once, only the followers, and never on the first check", async () => {
    const clock = { now: new Date("2026-10-20T10:00:00Z") };
    const show = { current: tv(100, { s: 1, e: 3, date: "2026-10-12" }) };
    const fan = profile("fan", { myList: ["tmdb-tv-100"] });
    const other = profile("other", { myList: ["tmdb-tv-200"] });
    const noEpisodes = profile("quiet", { myList: ["tmdb-tv-100"], prefs: { episodes: false } });
    const accounts: AccountView[] = [
      { id: "acct-1", role: "owner", profiles: [fan, noEpisodes] },
      { id: "acct-2", role: "user", profiles: [other] },
    ];
    const ctx = context(dir, accounts, { "/tv/100?append_to_response=content_ratings": () => show.current, "/tv/200?append_to_response=content_ratings": tv(200, { s: 1, e: 1, date: "2026-01-01" }) }, clock);
    await runSeriesJob(ctx);
    expect(listNotifications(dir, "acct-1", "fan").items).toEqual([]);

    show.current = tv(100, { s: 1, e: 4, date: "2026-10-19" });
    clock.now = new Date("2026-10-21T10:00:00Z");
    await runSeriesJob(ctx);
    await runSeriesJob(ctx); // a second run finds nothing new
    clock.now = new Date("2026-10-21T16:00:00Z");
    await runSeriesJob(ctx); // a later run with the same data, past the cache: still nothing new
    const fanItems = listNotifications(dir, "acct-1", "fan", { now: clock.now }).items;
    expect(fanItems).toHaveLength(1);
    expect(fanItems[0]).toMatchObject({ type: "new-episode", season: 1, episode: 4, tmdbId: 100 });
    expect(listNotifications(dir, "acct-1", "quiet", { now: clock.now }).items).toEqual([]);
    expect(listNotifications(dir, "acct-2", "other", { now: clock.now }).items).toEqual([]);
    expect(readState(dir).series["100"].lastAired).toMatchObject({ season: 1, episode: 4 });
  });

  it("keeps children's profiles to their maturity level (unknown ratings hidden)", async () => {
    const clock = { now: new Date("2026-10-20T10:00:00Z") };
    const shows = { mature: tv(1, { s: 1, e: 1, date: "2026-10-01" }, "TV-MA"), kid: tv(2, { s: 1, e: 1, date: "2026-10-01" }, "TV-Y7"), unrated: tv(3, { s: 1, e: 1, date: "2026-10-01" }, "") };
    const kids = profile("kids", { isKids: true, maturity: "kids", myList: ["tmdb-tv-1", "tmdb-tv-2", "tmdb-tv-3"] });
    const adult = profile("adult", { myList: ["tmdb-tv-1"] });
    const ctx = context(dir, [{ id: "fam", role: "user", profiles: [kids, adult] }], {
      "/tv/1?append_to_response=content_ratings": () => shows.mature,
      "/tv/2?append_to_response=content_ratings": () => shows.kid,
      "/tv/3?append_to_response=content_ratings": () => shows.unrated,
    }, clock);
    await runSeriesJob(ctx);
    shows.mature = tv(1, { s: 1, e: 2, date: "2026-10-21" }, "TV-MA");
    shows.kid = tv(2, { s: 1, e: 2, date: "2026-10-21" }, "TV-Y7");
    shows.unrated = tv(3, { s: 1, e: 2, date: "2026-10-21" }, "");
    clock.now = new Date("2026-10-23T10:00:00Z");
    await runSeriesJob(ctx);
    expect(listNotifications(dir, "fam", "kids", { now: clock.now }).items.map((i) => i.tmdbId)).toEqual([2]);
    expect(listNotifications(dir, "fam", "adult", { now: clock.now }).items.map((i) => i.tmdbId)).toEqual([1]);
  });

  it("caps work per run and survives one series failing", async () => {
    const clock = { now: new Date("2026-10-20T10:00:00Z") };
    const p = profile("p", { myList: ["tmdb-tv-1", "tmdb-tv-2"] });
    const ctx = context(dir, [{ id: "a", role: "user", profiles: [p] }], {
      "/tv/1?append_to_response=content_ratings": tv(1, { s: 1, e: 1, date: "2026-10-01" }),
      "/tv/2?append_to_response=content_ratings": () => new Response("busy", { status: 503 }),
    }, clock);
    const r = await runSeriesJob(ctx);
    expect(r.summary).toContain("2 series checked, 1 failed");
    expect(readState(dir).series["1"]).toBeDefined();
  });
});

describe("releases job (regions)", () => {
  it("tells each profile about releases in its own region only", async () => {
    const dir = freshDir();
    const clock = { now: new Date("2026-10-01T12:00:00Z") };
    const film = {
      id: 7,
      title: "The Film",
      poster_path: "/f.jpg",
      genres: [{ id: 878, name: "Science Fiction" }],
      release_dates: {
        results: [
          { iso_3166_1: "US", release_dates: [{ type: 3, release_date: "2026-08-01T00:00:00Z", certification: "PG-13" }, { type: 4, release_date: "2026-10-14T00:00:00Z" }] },
          { iso_3166_1: "GB", release_dates: [{ type: 4, release_date: "2026-11-30T00:00:00Z" }] },
        ],
      },
      "watch/providers": { results: {} },
    };
    const us = profile("us", { myList: ["tmdb-7"], prefs: { region: "US" } });
    const gb = profile("gb", { myList: ["tmdb-7"], prefs: { region: "GB" } });
    const ctx = context(dir, [{ id: "a", role: "user", profiles: [us, gb] }], {
      "/movie/7?append_to_response=release_dates,watch/providers": film,
      "/movie/7": film,
      "/discover/movie*": { results: [] },
    }, clock);
    await runReleasesJob(ctx);
    clock.now = new Date("2026-10-16T12:00:00Z");
    await runReleasesJob(ctx);
    await runReleasesJob(ctx);
    expect(listNotifications(dir, "a", "us", { now: clock.now }).items).toEqual([expect.objectContaining({ type: "digital-release", region: "US" })]);
    expect(listNotifications(dir, "a", "gb", { now: clock.now }).items).toEqual([]);
    clock.now = new Date("2026-12-02T12:00:00Z");
    await runReleasesJob(ctx);
    expect(listNotifications(dir, "a", "gb", { now: clock.now }).items).toEqual([expect.objectContaining({ type: "digital-release", region: "GB" })]);
  });
});

describe("trending and recommendations jobs", () => {
  const trending = {
    results: [
      { id: 11, media_type: "movie", title: "Space One", genre_ids: [878], poster_path: "/a.jpg", vote_average: 8 },
      { id: 12, media_type: "tv", name: "Space Show", genre_ids: [878, 18], poster_path: "/b.jpg", vote_average: 7 },
      { id: 13, media_type: "movie", title: "Romcom", genre_ids: [10749], poster_path: "/c.jpg", vote_average: 6 },
      { id: 14, media_type: "movie", title: "Space Two", genre_ids: [878], poster_path: "/d.jpg", vote_average: 6 },
      { id: 15, media_type: "person", name: "Somebody" },
    ],
  };
  const routes = {
    "/trending/all/week": trending,
    "/movie/1": { id: 1, title: "Alien", genres: [{ id: 878 }] },
    "/movie/1/recommendations": { results: [{ id: 21, title: "Rec A", genre_ids: [878], poster_path: "/r.jpg", vote_average: 7 }, { id: 22, title: "Rec B", genre_ids: [27], poster_path: "/s.jpg" }] },
  };

  it("sends at most a few matching titles, never repeats them and respects dismissals", async () => {
    const dir = freshDir();
    const clock = { now: new Date("2026-10-20T10:00:00Z") };
    const p = profile("p", { prefs: { digest: "instant" }, watched: [{ tmdbId: 1, mediaType: "movie", title: "Alien", at: clock.now.getTime() }] });
    const ctx = context(dir, [{ id: "a", role: "user", profiles: [p] }], routes, clock);
    await runTrendingJob(ctx);
    let items = listNotifications(dir, "a", "p", { now: clock.now }).items;
    expect(items.map((i) => i.tmdbId).sort()).toEqual([11, 12]);
    applyAction(dir, "a", "p", "dismiss", [items.find((i) => i.tmdbId === 11)!.id], clock.now);
    clock.now = new Date("2026-10-21T10:00:00Z");
    await runTrendingJob(ctx);
    items = listNotifications(dir, "a", "p", { now: clock.now }).items;
    // Only the remaining matching title is new; the romance is never suggested to this profile.
    expect(items.map((i) => i.tmdbId).sort()).toEqual([12, 14]);
  });

  it("sends one daily digest when the profile prefers it", async () => {
    const dir = freshDir();
    const clock = { now: new Date("2026-10-20T10:00:00Z") };
    const p = profile("p", { watched: [{ tmdbId: 1, mediaType: "movie", title: "Alien", at: clock.now.getTime() }] });
    const ctx = context(dir, [{ id: "a", role: "user", profiles: [p] }], routes, clock);
    await runTrendingJob(ctx);
    await runTrendingJob(ctx);
    await runRecommendationsJob(ctx);
    const items = listNotifications(dir, "a", "p", { now: clock.now }).items;
    expect(items.map((i) => i.type)).toEqual(["digest", "digest"]);
    const recDigest = items.find((i) => i.category === "recommendations")!;
    expect(recDigest.items?.map((i) => i.tmdbId)).toEqual([21, 22]);
    expect(recDigest.items?.[0].reason).toBe("Because you watched Alien");
    // Dismissing a digest suppresses its titles.
    applyAction(dir, "a", "p", "dismiss", [recDigest.id], clock.now);
    expect(Object.keys(readProfileInbox(dir, "a", "p").suppressed)).toEqual(expect.arrayContaining(["movie:21", "movie:22"]));
  });
});

// --- Scheduler ----------------------------------------------------------------------------------

describe("scheduler", () => {
  const ctxFor = (dir: string, clock: { now: Date }, routes: Routes, accounts: AccountView[] = []) => context(dir, accounts, routes, clock);

  it("runs each job once, records state, and resumes after a restart without replaying", async () => {
    const dir = freshDir();
    const clock = { now: new Date("2026-10-20T10:00:00Z") };
    const ctx = ctxFor(dir, clock, { "/trending/all/week": { results: [] } });
    const s1 = new NotificationScheduler({ ctx: () => ctx, owner: "proc-1", jobs: ["trending", "cleanup"] });
    await s1.tick();
    const st = readState(dir).jobs;
    expect(st.trending).toMatchObject({ failures: 0, lastSuccessAt: clock.now.toISOString(), nextRunAt: "2026-10-21T10:00:00.000Z" });
    const calls = ctx.calls.length;
    // "Restart": a new scheduler with a new identity after the lease expired.
    clock.now = new Date("2026-10-20T12:00:00Z");
    const s2 = new NotificationScheduler({ ctx: () => ctx, owner: "proc-2", jobs: ["trending", "cleanup"] });
    await s2.tick();
    expect(ctx.calls.length).toBe(calls); // not due yet
    clock.now = new Date("2026-10-23T12:00:00Z"); // two runs missed while off: run once
    await s2.tick();
    expect(readState(dir).jobs.trending.lastSuccessAt).toBe(clock.now.toISOString());
    expect(readState(dir).jobs.trending.nextRunAt).toBe("2026-10-24T12:00:00.000Z");
  });

  it("lets only one process run jobs (lease) and never overlaps passes", async () => {
    const dir = freshDir();
    const clock = { now: new Date("2026-10-20T10:00:00Z") };
    let running = 0;
    let maxParallel = 0;
    let started = 0;
    const slow = (async () => {
      running++;
      started++;
      maxParallel = Math.max(maxParallel, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return new Response(JSON.stringify({ results: [] }));
    }) as unknown as typeof fetch;
    const ctx: JobContext = {
      dir,
      now: () => clock.now,
      tmdb: createTmdbClient({ apiKey: "testkey0123456789abcdef", fetchImpl: slow, minIntervalMs: 0, sleep: async () => {}, now: () => clock.now.getTime() }),
      accounts: () => [],
      log: () => {},
    };
    const a = new NotificationScheduler({ ctx: () => ctx, owner: "A", jobs: ["trending"] });
    const b = new NotificationScheduler({ ctx: () => ctx, owner: "B", jobs: ["trending"] });
    await Promise.all([a.tick(), a.tick(), b.tick(), b.tick()]);
    expect(started).toBe(1);
    expect(maxParallel).toBe(1);
    expect(acquireLease(dir, "B", clock.now.getTime())).toBe(false);
    // The holder disappears: its lease expires and another process takes over.
    expect(acquireLease(dir, "B", clock.now.getTime() + 10 * 60_000)).toBe(true);
  });

  it("backs off after failures, notifies the owner after three, and recovers", async () => {
    const dir = freshDir();
    const clock = { now: new Date("2026-10-20T10:00:00Z") };
    const answer = { fail: true };
    const owner: AccountView = { id: "owner", role: "owner", profiles: [profile("main"), profile("kid", { isKids: true, maturity: "kids" })] };
    const user: AccountView = { id: "user", role: "user", profiles: [profile("u")] };
    const ctx = ctxFor(dir, clock, { "/trending/all/week": () => (answer.fail ? new Response("down", { status: 503 }) : { results: [] }) }, [owner, user]);
    const s = new NotificationScheduler({ ctx: () => ctx, owner: "S", jobs: ["trending"] });
    const expectedBackoff = [15, 30, 60];
    for (let i = 0; i < 3; i++) {
      await s.tick();
      const j = readState(dir).jobs.trending;
      expect(j.failures).toBe(i + 1);
      expect(Date.parse(j.nextRunAt!) - clock.now.getTime()).toBe(expectedBackoff[i] * 60_000);
      clock.now = new Date(Date.parse(j.nextRunAt!));
    }
    expect(backoffMs(10, 6 * 3_600_000)).toBe(6 * 3_600_000);
    const notice = listNotifications(dir, "owner", "main", { now: clock.now }).items;
    expect(notice).toEqual([expect.objectContaining({ type: "service", category: "service", url: "/settings#notifications" })]);
    expect(listNotifications(dir, "owner", "kid", { now: clock.now }).items).toEqual([]);
    expect(listNotifications(dir, "user", "u", { now: clock.now }).items).toEqual([]);
    // TMDB is back: the job succeeds and the failure state clears.
    answer.fail = false;
    await s.tick();
    expect(readState(dir).jobs.trending.failures).toBe(0);
    expect(readState(dir).service["job-trending"]).toBeUndefined();
  });

  it("retries a temporary TMDB error within one request and stops at a rejected key", async () => {
    let calls = 0;
    const flaky = (async () => (++calls < 3 ? new Response("", { status: 429, headers: { "retry-after": "1" } }) : new Response('{"ok":1}'))) as unknown as typeof fetch;
    const waits: number[] = [];
    const client = createTmdbClient({ apiKey: "testkey0123456789abcdef", fetchImpl: flaky, minIntervalMs: 0, sleep: async (ms) => void waits.push(ms) });
    await expect(client.get("/x")).resolves.toEqual({ ok: 1 });
    expect(calls).toBe(3);
    expect(waits.filter((w) => w > 0).length).toBeGreaterThan(0);
    await client.get("/x"); // cached
    expect(calls).toBe(3);
    const rejected = createTmdbClient({ apiKey: "testkey0123456789abcdef", fetchImpl: (async () => new Response("", { status: 401 })) as unknown as typeof fetch, sleep: async () => {} });
    await expect(rejected.get("/y")).rejects.toThrow("TMDB rejected");
  });

  it("defines the documented intervals", () => {
    expect(Object.fromEntries(Object.entries(JOBS).map(([k, v]) => [k, v.intervalMs / 3_600_000]))).toEqual({ series: 6, releases: 12, trending: 24, recommendations: 24, service: 6, cleanup: 24 });
  });
});

// --- Web Push --------------------------------------------------------------------------------------

/** A browser's push keys, and a fake push service that checks VAPID and decrypts like a browser. */
function fakeBrowser() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
}

describe("web push", () => {
  it("validates endpoints so the server only contacts browser push services", () => {
    expect(checkEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBeNull();
    expect(checkEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBeNull();
    expect(checkEndpoint("https://web.push.apple.com/x")).toBeNull();
    expect(checkEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBeNull();
    expect(checkEndpoint("http://fcm.googleapis.com/x")).toMatch(/HTTPS/);
    expect(checkEndpoint("https://127.0.0.1/x")).toMatch(/not supported/);
    expect(checkEndpoint("https://fcm.googleapis.com.evil.example/x")).toMatch(/not supported/);
    expect(checkEndpoint("https://user:pw@fcm.googleapis.com/x")).toMatch(/HTTPS/);
  });

  it("keeps subscriptions per profile, moves a re-registered browser and removes only own ones", () => {
    const dir = freshDir();
    const b = fakeBrowser();
    const endpoint = "https://fcm.googleapis.com/fcm/send/one";
    saveSubscription(dir, { accountId: "a", profileId: "p1", endpoint, ...b.keys });
    expect(listSubscriptions(dir, { accountId: "a", profileId: "p1" })).toHaveLength(1);
    saveSubscription(dir, { accountId: "a", profileId: "p2", endpoint, ...b.keys });
    expect(listSubscriptions(dir, { accountId: "a", profileId: "p1" })).toHaveLength(0);
    expect(listSubscriptions(dir, { accountId: "a", profileId: "p2" })).toHaveLength(1);
    expect(removeSubscription(dir, "someone-else", endpoint)).toBe(false);
    expect(removeSubscription(dir, "a", endpoint)).toBe(true);
    expect(listSubscriptions(dir)).toEqual([]);
  });

  it("delivers encrypted, signed pushes with no sensitive data; holds quiet hours; drops gone subscriptions", async () => {
    const dir = freshDir();
    const vapid = generateVapidKeys();
    const browser = fakeBrowser();
    const endpoint = "https://fcm.googleapis.com/fcm/send/device-1";
    const received: Array<{ payload: Record<string, unknown>; headers: Headers }> = [];
    let status = 201;
    const pushService = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const v = verifyVapid(headers.get("authorization") ?? "", url);
      expect(v.ok).toBe(true);
      expect(v.publicKey).toBe(vapid.publicKey);
      expect(headers.get("content-encoding")).toBe("aes128gcm");
      const plain = decryptPayload(Buffer.from(init.body as Uint8Array), { ecdh: browser.ecdh, auth: browser.auth });
      received.push({ payload: JSON.parse(plain.toString("utf8")), headers });
      return new Response("", { status });
    }) as unknown as typeof fetch;

    const clock = { now: new Date("2026-10-20T15:00:00Z") };
    const p = profile("p", { prefs: { browser: true, timeZone: "UTC", quietHours: { enabled: true, start: "22:00", end: "08:00" } } });
    const ctx: JobContext = { dir, now: () => clock.now, tmdb: null, accounts: () => [{ id: "a", role: "user", profiles: [p] }], log: () => {}, push: { keys: vapid, subject: "mailto:test@example.invalid", fetchImpl: pushService } };
    saveSubscription(dir, { accountId: "a", profileId: "p", endpoint, ...browser.keys });
    const content = { dedupeKey: "ep:1:1:1", type: "new-episode" as const, category: "episodes" as const, tmdbId: 1, mediaType: "tv" as const, title: "Show: new episode", body: "S1 E1 is out.", image: "/x.jpg", url: "/browse?title=tmdb-tv-1&season=1", source: "tmdb" as const, priority: "normal" as const, ttlDays: 60 };
    deliver(dir, "a", "p", [content], { now: clock.now, enabled: () => true, push: true });
    expect(await dispatchPushes(ctx)).toEqual({ sent: 1, held: 0, skipped: 0 });
    expect(received[0].payload).toEqual({ title: "Show: new episode", body: "S1 E1 is out.", url: "/browse?title=tmdb-tv-1&season=1", tag: expect.stringMatching(/^[a-f0-9]{24}$/), icon: "https://image.tmdb.org/t/p/w185/x.jpg" });
    expect(await dispatchPushes(ctx)).toEqual({ sent: 0, held: 0, skipped: 0 }); // sent once only

    // Quiet hours: held, then sent when they end.
    clock.now = new Date("2026-10-20T23:00:00Z");
    deliver(dir, "a", "p", [{ ...content, dedupeKey: "ep:1:1:2", title: "Second" }], { now: clock.now, enabled: () => true, push: true });
    expect(await dispatchPushes(ctx)).toEqual({ sent: 0, held: 1, skipped: 0 });
    clock.now = new Date("2026-10-21T08:30:00Z");
    expect((await dispatchPushes(ctx)).sent).toBe(1);

    // The browser unsubscribed or revoked permission: the push service answers 410 → removed.
    status = 410;
    deliver(dir, "a", "p", [{ ...content, dedupeKey: "ep:1:1:3" }], { now: clock.now, enabled: () => true, push: true });
    await dispatchPushes(ctx);
    expect(listSubscriptions(dir)).toEqual([]);
    expect(readProfileInbox(dir, "a", "p").items[0].push).toBe("failed");
    // No credentials or stream data in any payload.
    expect(JSON.stringify(received)).not.toMatch(/token|api_key|real-?debrid|password|stream/i);
  });

  it("drops browsers registered before the account was signed out everywhere (password change)", async () => {
    const dir = freshDir();
    const browser = fakeBrowser();
    let sent = 0;
    const p = profile("p", { prefs: { browser: true, quietHours: { enabled: false, start: "22:00", end: "08:00" } } });
    const account: AccountView = { id: "a", role: "user", profiles: [p], sessionVersion: 0 };
    const ctx: JobContext = { dir, now: () => new Date("2026-10-20T12:00:00Z"), tmdb: null, accounts: () => [account], log: () => {}, push: { keys: generateVapidKeys(), subject: "mailto:x@example.invalid", fetchImpl: (async () => (sent++, new Response("", { status: 201 }))) as unknown as typeof fetch } };
    saveSubscription(dir, { accountId: "a", profileId: "p", endpoint: "https://fcm.googleapis.com/fcm/send/old-session", ...browser.keys, sessionVersion: 0 });
    account.sessionVersion = 1; // password changed
    deliver(dir, "a", "p", [{ dedupeKey: "k", type: "service", category: "service", title: "t", body: "b", url: "/settings", source: "notflix", priority: "high", ttlDays: 1 }], { now: new Date("2026-10-20T12:00:00Z"), enabled: () => true, push: true });
    await dispatchPushes(ctx);
    expect(sent).toBe(0);
    expect(listSubscriptions(dir)).toEqual([]);
  });

  it("does not push when the profile turned browser notifications off", async () => {
    const dir = freshDir();
    const browser = fakeBrowser();
    let sent = 0;
    const p = profile("p", { prefs: { browser: false } });
    const ctx: JobContext = { dir, now: () => new Date("2026-10-20T12:00:00Z"), tmdb: null, accounts: () => [{ id: "a", role: "user", profiles: [p] }], log: () => {}, push: { keys: generateVapidKeys(), subject: "mailto:x@example.invalid", fetchImpl: (async () => (sent++, new Response(""))) as unknown as typeof fetch } };
    saveSubscription(dir, { accountId: "a", profileId: "p", endpoint: "https://fcm.googleapis.com/fcm/send/x", ...browser.keys });
    deliver(dir, "a", "p", [{ dedupeKey: "k", type: "service", category: "service", title: "t", body: "b", url: "/settings", source: "notflix", priority: "high", ttlDays: 1 }], { now: new Date("2026-10-20T12:00:00Z"), enabled: () => true, push: true });
    expect((await dispatchPushes(ctx)).skipped).toBe(1);
    expect(sent).toBe(0);
  });
});

// --- Restart and existing installations -------------------------------------------------------

describe("persistence", () => {
  it("keeps notifications, read state and snapshots across a restart (files only)", async () => {
    const dir = freshDir();
    const clock = { now: new Date("2026-10-20T10:00:00Z") };
    deliver(dir, "a", "p", [{ dedupeKey: "k", type: "trending", category: "trending", title: "t", body: "b", url: "/browse", source: "tmdb", priority: "low", ttlDays: 14 }], { now: clock.now, enabled: () => true });
    const id = listNotifications(dir, "a", "p", { now: clock.now }).items[0].id;
    applyAction(dir, "a", "p", "read", [id], clock.now);
    updateState(dir, (s) => {
      s.series["5"] = { title: "x", firstSeen: clock.now.toISOString(), checkedAt: clock.now.toISOString(), seasons: {} };
    });
    // Nothing is kept in memory: a new process reading the same folder sees the same state.
    const again = listNotifications(dir, "a", "p", { now: clock.now });
    expect(again.items[0]).toMatchObject({ id, readAt: clock.now.toISOString() });
    expect(readState(dir).series["5"].title).toBe("x");
    // A damaged inbox file is kept for recovery, not silently overwritten.
    const file = path.join(dir, "inbox", "a.json");
    fs.writeFileSync(file, "{ broken");
    expect(listNotifications(dir, "a", "p").items).toEqual([]);
    expect(fs.readdirSync(path.join(dir, "inbox")).some((f) => f.startsWith("a.json.corrupt-"))).toBe(true);
  });
});
