/**
 * Detection and ranking rules with fixed dates (no network): episode/season detection, film
 * release classification per region, trending/recommendation ranking, preferences, quiet hours.
 */
import { describe, expect, it } from "vitest";
import {
  buildInterest,
  classifyReleases,
  detectMovie,
  detectSeries,
  isAvailable,
  rankRecommendations,
  rankTrending,
  type Candidate,
  type TmdbMovieDetails,
  type TmdbTvDetails,
} from "./detect";
import { DEFAULT_NOTIFICATION_PREFERENCES, inQuietHours, normalizeNotificationPreferences, regionFromLocale } from "./preferences";
import { normalizeProfilePreferences } from "../profile-preferences";

const at = (iso: string) => new Date(iso);

function show(over: Partial<TmdbTvDetails> = {}): TmdbTvDetails {
  return {
    id: 100,
    name: "The Show",
    poster_path: "/show.jpg",
    seasons: [
      { season_number: 0, episode_count: 3, air_date: "2019-01-01" },
      { season_number: 1, episode_count: 10, air_date: "2025-01-10" },
      { season_number: 2, episode_count: 8, air_date: "2026-10-01" },
    ],
    last_episode_to_air: { season_number: 2, episode_number: 3, air_date: "2026-10-15", name: "Third" },
    content_ratings: { results: [{ iso_3166_1: "US", rating: "TV-14" }] },
    ...over,
  };
}

describe("availability rule (time zones)", () => {
  it("counts a date as aired from 08:00 UTC the next day", () => {
    expect(isAvailable("2026-10-20", at("2026-10-20T23:00:00Z"))).toBe(false);
    expect(isAvailable("2026-10-20", at("2026-10-21T07:59:00Z"))).toBe(false);
    expect(isAvailable("2026-10-20", at("2026-10-21T08:00:00Z"))).toBe(true);
    expect(isAvailable(null, at("2030-01-01T00:00:00Z"))).toBe(false);
    expect(isAvailable("not a date", at("2030-01-01T00:00:00Z"))).toBe(false);
  });
});

describe("series: new episodes and seasons", () => {
  const now = at("2026-10-20T12:00:00Z");

  it("records a baseline the first time and announces nothing (no retroactive alerts)", () => {
    const r = detectSeries(undefined, show(), now);
    expect(r.events).toEqual([]);
    expect(r.snapshot.lastAired).toEqual({ season: 2, episode: 3, airDate: "2026-10-15" });
    expect(r.snapshot.seasons["2"].released).toBe(true);
    expect(r.snapshot.seasons["0"]).toBeUndefined();
  });

  it("announces one genuinely new episode, with a stable key and a season link", () => {
    const base = detectSeries(undefined, show(), now).snapshot;
    const later = at("2026-10-23T09:00:00Z");
    const r = detectSeries(base, show({ last_episode_to_air: { season_number: 2, episode_number: 4, air_date: "2026-10-22", name: "Fourth" } }), later);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      type: "new-episode",
      category: "episodes",
      dedupeKey: "ep:100:2:4",
      season: 2,
      episode: 4,
      url: "/browse?title=tmdb-tv-100&season=2",
      certification: "TV-14",
      title: "The Show: new episode",
    });
    expect(r.events[0].body).toContain("S2 E4 · Fourth");
    // The same data again: nothing new.
    expect(detectSeries(r.snapshot, show({ last_episode_to_air: { season_number: 2, episode_number: 4, air_date: "2026-10-22" } }), later).events).toEqual([]);
  });

  it("groups several episodes released together into one notification", () => {
    const base = detectSeries(undefined, show(), now).snapshot;
    const r = detectSeries(base, show({ last_episode_to_air: { season_number: 2, episode_number: 7, air_date: "2026-10-22" } }), at("2026-10-23T09:00:00Z"));
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: "new-episodes", episode: 4, episodeTo: 7, dedupeKey: "ep:100:2:7" });
    expect(r.events[0].body).toBe("Season 2, episodes 4–7 are out.");
  });

  it("waits for the air date to pass everywhere before announcing", () => {
    const base = detectSeries(undefined, show(), now).snapshot;
    const ep = { season_number: 2, episode_number: 4, air_date: "2026-10-22" };
    const early = detectSeries(base, show({ last_episode_to_air: ep }), at("2026-10-22T20:00:00Z"));
    expect(early.events).toEqual([]);
    expect(early.snapshot.lastAired?.episode).toBe(3);
    expect(detectSeries(early.snapshot, show({ last_episode_to_air: ep }), at("2026-10-23T08:30:00Z")).events).toHaveLength(1);
  });

  it("does not announce old episodes added to TMDB later (metadata backfill)", () => {
    const base = detectSeries(undefined, show(), now).snapshot;
    const r = detectSeries(base, show({ last_episode_to_air: { season_number: 2, episode_number: 4, air_date: "2026-09-01" } }), now);
    expect(r.events).toEqual([]);
    expect(r.snapshot.lastAired?.episode).toBe(4);
  });

  it("ignores episodes without an air date and corrections that move backwards", () => {
    const base = detectSeries(undefined, show(), now).snapshot;
    expect(detectSeries(base, show({ last_episode_to_air: { season_number: 2, episode_number: 4, air_date: null } }), now).events).toEqual([]);
    const corrected = detectSeries(base, show({ last_episode_to_air: { season_number: 2, episode_number: 2, air_date: "2026-10-08" } }), now);
    expect(corrected.events).toEqual([]);
    expect(corrected.snapshot.lastAired?.episode).toBe(2);
  });

  it("distinguishes a season announcement from its release", () => {
    const base = detectSeries(undefined, show(), now).snapshot;
    const withS3 = (airDate: string | null, lea = show().last_episode_to_air) =>
      show({ seasons: [...show().seasons!, { season_number: 3, episode_count: 0, air_date: airDate }], last_episode_to_air: lea });
    const announced = detectSeries(base, withS3("2027-03-01"), now);
    expect(announced.events).toEqual([expect.objectContaining({ type: "season-announced", dedupeKey: "season-announced:100:3", priority: "low" })]);
    expect(announced.events[0].body).toContain("Mar 1, 2027");
    // Release day: one "season is here" notification, not also one for episode 1.
    const released = detectSeries(announced.snapshot, withS3("2027-03-01", { season_number: 3, episode_number: 1, air_date: "2027-03-01" }), at("2027-03-02T09:00:00Z"));
    expect(released.events).toEqual([expect.objectContaining({ type: "season-released", dedupeKey: "season-released:100:3", body: "The first episode is out." })]);
    // Episode 2 a week later: a normal episode notification.
    const ep2 = detectSeries(released.snapshot, withS3("2027-03-01", { season_number: 3, episode_number: 2, air_date: "2027-03-08" }), at("2027-03-09T09:00:00Z"));
    expect(ep2.events).toEqual([expect.objectContaining({ type: "new-episode", dedupeKey: "ep:100:3:2" })]);
  });

  it("announces a whole season dropped at once as a season release", () => {
    const base = detectSeries(undefined, show(), now).snapshot;
    const drop = show({
      seasons: [...show().seasons!, { season_number: 3, episode_count: 6, air_date: "2026-10-24" }],
      last_episode_to_air: { season_number: 3, episode_number: 6, air_date: "2026-10-24" },
    });
    const r = detectSeries(base, drop, at("2026-10-25T09:00:00Z"));
    expect(r.events.map((e) => e.type)).toEqual(["season-released"]);
    expect(r.events[0].body).toBe("All 6 episodes are out.");
  });

  it("does not announce placeholder seasons years away", () => {
    const base = detectSeries(undefined, show(), now).snapshot;
    const r = detectSeries(base, show({ seasons: [...show().seasons!, { season_number: 3, episode_count: 0, air_date: "2031-01-01" }] }), now);
    expect(r.events).toEqual([]);
  });
});

describe("films: release classification and regions", () => {
  const film = (over: Partial<TmdbMovieDetails> = {}): TmdbMovieDetails => ({
    id: 7,
    title: "The Film",
    poster_path: "/film.jpg",
    release_dates: {
      results: [
        {
          iso_3166_1: "US",
          release_dates: [
            { type: 3, release_date: "2026-08-01T00:00:00.000Z", certification: "PG-13" },
            { type: 4, release_date: "2026-10-14T00:00:00.000Z", certification: "" },
            { type: 5, release_date: "2026-11-20T00:00:00.000Z" },
          ],
        },
        { iso_3166_1: "GB", release_dates: [{ type: 3, release_date: "2026-08-05T00:00:00.000Z", certification: "12A" }] },
      ],
    },
    "watch/providers": { results: { US: { flatrate: [] } } },
    ...over,
  });

  it("keeps theatrical, digital, physical and TV releases apart, per region", () => {
    expect(classifyReleases(film(), "US")).toEqual({ theatrical: "2026-08-01", digital: "2026-10-14", physical: "2026-11-20" });
    expect(classifyReleases(film(), "GB")).toEqual({ theatrical: "2026-08-05" });
    expect(classifyReleases(film(), "DE")).toEqual({});
  });

  it("announces a digital release once, in the region where it happened, without claiming it can be played", () => {
    const base = detectMovie(undefined, film(), "US", at("2026-10-01T12:00:00Z")).snapshot;
    expect(base.notified).toEqual({ digital: false, physical: false });
    const r = detectMovie(base, film(), "US", at("2026-10-16T12:00:00Z"));
    expect(r.events).toEqual([expect.objectContaining({ type: "digital-release", category: "digital", dedupeKey: "digital:7:US", region: "US", certification: "PG-13" })]);
    expect(r.events[0].body).toMatch(/buy or rent digitally in US/);
    expect(r.events[0].body).not.toMatch(/play|Real-Debrid/i);
    expect(detectMovie(r.snapshot, film(), "US", at("2026-10-17T12:00:00Z")).events).toEqual([]);
    // The UK has no digital release: nothing there.
    const gb = detectMovie(detectMovie(undefined, film(), "GB", at("2026-10-01T12:00:00Z")).snapshot, film(), "GB", at("2026-10-16T12:00:00Z"));
    expect(gb.events).toEqual([]);
  });

  it("announces physical releases separately", () => {
    let snap = detectMovie(undefined, film(), "US", at("2026-10-01T12:00:00Z")).snapshot;
    snap = detectMovie(snap, film(), "US", at("2026-10-16T12:00:00Z")).snapshot;
    const r = detectMovie(snap, film(), "US", at("2026-11-21T12:00:00Z"));
    expect(r.events).toEqual([expect.objectContaining({ type: "physical-release", category: "physical", dedupeKey: "physical:7:US" })]);
  });

  it("does not announce releases that were already out when the film was first seen", () => {
    const base = detectMovie(undefined, film(), "US", at("2026-12-01T12:00:00Z")).snapshot;
    expect(base.notified).toEqual({ digital: true, physical: true });
    expect(detectMovie(base, film(), "US", at("2026-12-02T12:00:00Z")).events).toEqual([]);
  });

  it("reports a new streaming service with JustWatch attribution, separately from digital releases", () => {
    const base = detectMovie(undefined, film(), "US", at("2026-12-01T12:00:00Z")).snapshot;
    const streaming = film({ "watch/providers": { results: { US: { flatrate: [{ provider_id: 8, provider_name: "Netflix" }] } } } });
    const r = detectMovie(base, streaming, "US", at("2026-12-05T12:00:00Z"));
    expect(r.events).toEqual([expect.objectContaining({ type: "streaming-available", category: "digital", source: "justwatch-via-tmdb", dedupeKey: "stream:7:US:8" })]);
    expect(r.events[0].body).toContain("Now on Netflix in US");
    expect(r.events[0].body).toContain("JustWatch");
  });
});

describe("trending and recommendations", () => {
  const c = (tmdbId: number, genreIds: number[], over: Partial<Candidate> = {}): Candidate => ({ tmdbId, mediaType: "movie", title: `T${tmdbId}`, genreIds, posterPath: "/p.jpg", vote: 7, ...over });
  const seeds = [
    { tmdbId: 1, mediaType: "movie" as const, title: "Alien", genreIds: [878, 27], weight: 2, kind: "watched" as const },
    { tmdbId: 2, mediaType: "tv" as const, title: "Dark", genreIds: [878, 18], weight: 1, kind: "list" as const },
  ];

  it("prefers titles matching the profile's interests and skips what it already has", () => {
    const interest = buildInterest(seeds);
    const list = [c(10, [35]), c(11, [878]), c(12, [27, 53]), c(13, [878, 18]), c(14, [10751], { adult: true }), c(15, [878], { posterPath: undefined })];
    const picks = rankTrending(list, interest, new Set(["movie:13"]), 5);
    expect(picks.map((p) => p.tmdbId)).toEqual([11, 12]);
    expect(rankTrending(list, interest, new Set(), 1)).toHaveLength(1);
  });

  it("suggests at most one generic title to a profile without history", () => {
    expect(rankTrending([c(10, [35]), c(11, [878])], new Map(), new Set(), 5).map((p) => p.tmdbId)).toEqual([10]);
  });

  it("ranks recommendations shared by several seeds first and explains them", () => {
    const watchedBoth = [seeds[0], { ...seeds[1], weight: 2, kind: "watched" as const }];
    const recs = rankRecommendations(
      [
        // Seed weight / (position + 1): 20 → 2; 21 → 1 + 2 = 3; 23 → 1.
        { seed: watchedBoth[0], recs: [c(20, [878]), c(21, [27]), c(22, [35])] },
        { seed: watchedBoth[1], recs: [c(21, [27]), c(23, [18])] },
      ],
      buildInterest(watchedBoth),
      new Set(["movie:22"]),
      3
    );
    expect(recs.map((r) => r.tmdbId)).toEqual([21, 20, 23]);
    expect(recs.map((r) => r.reason)).toEqual(["Because you watched Dark", "Because you watched Alien", "Because you watched Dark"]);
    const fromList = rankRecommendations([{ seed: seeds[1], recs: [c(30, [18])] }], buildInterest(seeds), new Set(), 3);
    expect(fromList[0].reason).toBe("Because you saved Dark");
  });
});

describe("notification preferences", () => {
  it("has the documented defaults and fills them in for profiles saved before notifications existed", () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES).toMatchObject({ episodes: true, seasons: true, digital: true, physical: false, trending: true, recommendations: true, service: true, browser: false });
    const old = normalizeProfilePreferences({ audioLanguage: "de", subtitlesEnabled: true });
    expect(old.audioLanguage).toBe("de");
    expect(old.notifications).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it("merges partial changes and rejects invalid values", () => {
    const base = normalizeNotificationPreferences({ physical: true, region: "gb", timeZone: "Europe/London" });
    expect(base).toMatchObject({ physical: true, region: "GB", timeZone: "Europe/London" });
    const next = normalizeNotificationPreferences({ trending: false, region: "Narnia", timeZone: "Mars/Base", digest: "hourly", quietHours: { start: "25:00", end: "06:30" } }, base);
    expect(next).toMatchObject({ physical: true, trending: false, region: "GB", timeZone: "Europe/London", digest: "daily", quietHours: { enabled: true, start: "22:00", end: "06:30" } });
  });

  it("applies quiet hours in the profile's time zone, across midnight", () => {
    const prefs = normalizeNotificationPreferences({ timeZone: "America/New_York", quietHours: { enabled: true, start: "22:00", end: "07:00" } });
    expect(inQuietHours(prefs, at("2026-10-21T03:30:00Z"))).toBe(true); // 23:30 in New York
    expect(inQuietHours(prefs, at("2026-10-21T12:00:00Z"))).toBe(false); // 08:00
    expect(inQuietHours({ ...prefs, quietHours: { ...prefs.quietHours, enabled: false } }, at("2026-10-21T03:30:00Z"))).toBe(false);
  });

  it("reads the region from a browser locale", () => {
    expect(regionFromLocale("en-GB")).toBe("GB");
    expect(regionFromLocale("pt_br")).toBe("BR");
    expect(regionFromLocale("en")).toBe("");
  });
});
