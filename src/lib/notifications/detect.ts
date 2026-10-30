/**
 * Pure detection and ranking rules (no I/O, deterministic for a given `now`), used by the
 * background jobs and covered by unit tests.
 *
 * Time rules
 * - TMDB air and release dates are calendar dates without a time zone (the date in the country of
 *   origin / the release region). An episode or release counts as available from 08:00 UTC on the
 *   following day, i.e. once that date has ended everywhere from New Zealand to the US west coast.
 *   Notifications may therefore arrive up to a day "late", never before the date.
 * - The first time a series or film is checked, everything already out is recorded as the baseline
 *   and announced to nobody: adding a show (or TMDB adding old episodes) never produces a burst of
 *   notifications about the past. After that only events dated within the last 14 days (30 for
 *   film releases) are announced; anything older is recorded silently (metadata backfills).
 * - Dates that are missing produce no "released" notification until a date appears.
 */
import type { NotificationContent } from "./types";

const DAY = 86_400_000;
export const EPISODE_RECENT_DAYS = 14;
export const RELEASE_RECENT_DAYS = 30;
/** Announcements further out than this are treated as placeholders and not announced. */
const ANNOUNCE_HORIZON_DAYS = 548;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Midnight UTC of a YYYY-MM-DD date (also accepts ISO date-times; the date part is used). */
export function dateMs(date: string | null | undefined): number | null {
  const m = DATE_RE.exec(date ?? "");
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Available from 08:00 UTC the day after the date (see the time rules above). */
export function isAvailable(date: string | null | undefined, now: Date): boolean {
  const t = dateMs(date);
  return t !== null && now.getTime() >= t + DAY + 8 * 3_600_000;
}

/** Whether the date lies within the last `days` days (and is not in the future). */
export function isRecent(date: string | null | undefined, now: Date, days: number): boolean {
  const t = dateMs(date);
  return t !== null && t >= now.getTime() - days * DAY && t <= now.getTime();
}

function formatDate(date: string): string {
  const t = dateMs(date);
  return t === null ? date : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// --- Series ---------------------------------------------------------------------------------------

export interface TmdbEpisodeRef {
  season_number: number;
  episode_number: number;
  air_date: string | null;
  name?: string;
  still_path?: string | null;
}

export interface TmdbTvDetails {
  id: number;
  name: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  status?: string;
  genres?: Array<{ id: number; name: string }>;
  last_episode_to_air?: TmdbEpisodeRef | null;
  next_episode_to_air?: TmdbEpisodeRef | null;
  seasons?: Array<{ season_number: number; episode_count: number; air_date: string | null; name?: string }>;
  content_ratings?: { results: Array<{ iso_3166_1: string; rating: string }> };
}

export interface SeriesSnapshot {
  title: string;
  /** When the series was first checked (the baseline). */
  firstSeen: string;
  checkedAt: string;
  lastAired?: { season: number; episode: number; airDate: string };
  seasons: Record<string, { airDate: string | null; episodes: number; released: boolean }>;
}

const later = (a: { season: number; episode: number }, b: { season: number; episode: number } | undefined) =>
  !b || a.season > b.season || (a.season === b.season && a.episode > b.episode);

export function tvCertification(d: TmdbTvDetails): string | null {
  return d.content_ratings?.results.find((r) => r.iso_3166_1 === "US")?.rating?.trim() || null;
}

const tvUrl = (id: number, season?: number) => `/browse?title=tmdb-tv-${id}${season ? `&season=${season}` : ""}`;

/**
 * Compares a series' current TMDB data with the last snapshot. Returns the new snapshot and the
 * notifications for its followers.
 */
export function detectSeries(prev: SeriesSnapshot | undefined, d: TmdbTvDetails, now: Date): { snapshot: SeriesSnapshot; events: NotificationContent[] } {
  const seasons = (d.seasons ?? []).filter((s) => s.season_number > 0);
  const lea = d.last_episode_to_air && d.last_episode_to_air.air_date ? d.last_episode_to_air : null;
  const nowIso = now.toISOString();
  const base = {
    tmdbId: d.id,
    mediaType: "tv" as const,
    name: d.name,
    image: d.poster_path ?? undefined,
    certification: tvCertification(d),
    source: "tmdb" as const,
    subject: `tv:${d.id}`,
  };

  if (!prev) {
    const snapshot: SeriesSnapshot = {
      title: d.name,
      firstSeen: nowIso,
      checkedAt: nowIso,
      ...(lea ? { lastAired: { season: lea.season_number, episode: lea.episode_number, airDate: lea.air_date! } } : {}),
      seasons: Object.fromEntries(
        seasons.map((s) => [String(s.season_number), { airDate: s.air_date, episodes: s.episode_count, released: isAvailable(s.air_date, now) || (lea ? lea.season_number >= s.season_number : false) }])
      ),
    };
    return { snapshot, events: [] };
  }

  const events: NotificationContent[] = [];
  const releasedNow = new Set<number>();
  const nextSeasons: SeriesSnapshot["seasons"] = {};
  for (const s of seasons) {
    const key = String(s.season_number);
    const before = prev.seasons[key];
    const available = isAvailable(s.air_date, now) || Boolean(lea && lea.season_number >= s.season_number && isAvailable(lea.air_date, now));
    if (!before && !available) {
      // A season TMDB did not list before and that has not started: an announcement.
      const t = dateMs(s.air_date);
      const plausible = t === null || (t > now.getTime() && t - now.getTime() < ANNOUNCE_HORIZON_DAYS * DAY);
      if (plausible) {
        events.push({
          ...base,
          dedupeKey: `season-announced:${d.id}:${s.season_number}`,
          type: "season-announced",
          category: "seasons",
          season: s.season_number,
          title: `${d.name}: Season ${s.season_number} announced`,
          body: s.air_date ? `Premieres ${formatDate(s.air_date)} (announced, not out yet).` : "Announced; no premiere date yet.",
          eventDate: s.air_date ?? undefined,
          url: tvUrl(d.id, s.season_number),
          priority: "low",
          ttlDays: 60,
        });
      }
    }
    const seasonStart = s.air_date ?? (lea?.season_number === s.season_number ? lea.air_date : null);
    if (available && !before?.released && isRecent(seasonStart, now, EPISODE_RECENT_DAYS)) releasedNow.add(s.season_number);
    nextSeasons[key] = { airDate: s.air_date, episodes: s.episode_count, released: available || Boolean(before?.released) };
  }

  for (const n of releasedNow) {
    const aired = lea && lea.season_number === n ? lea.episode_number : 1;
    const total = seasons.find((s) => s.season_number === n)?.episode_count ?? 0;
    events.push({
      ...base,
      dedupeKey: `season-released:${d.id}:${n}`,
      type: "season-released",
      category: "seasons",
      season: n,
      title: `${d.name}: Season ${n} is here`,
      body: aired > 1 ? (total > 0 && aired >= total ? `All ${total} episodes are out.` : `${aired} episodes are out.`) : "The first episode is out.",
      eventDate: seasons.find((s) => s.season_number === n)?.air_date ?? lea?.air_date ?? undefined,
      url: tvUrl(d.id, n),
      priority: "high",
      ttlDays: 60,
    });
  }

  let lastAired = prev.lastAired;
  if (lea && isAvailable(lea.air_date, now)) {
    const current = { season: lea.season_number, episode: lea.episode_number, airDate: lea.air_date! };
    if (later(current, prev.lastAired) && isRecent(lea.air_date, now, EPISODE_RECENT_DAYS) && !releasedNow.has(lea.season_number)) {
      const from = prev.lastAired && prev.lastAired.season === current.season ? prev.lastAired.episode + 1 : 1;
      const single = from >= current.episode;
      const name = lea.name && !/^episode \d+$/i.test(lea.name.trim()) ? lea.name.trim() : "";
      events.push({
        ...base,
        dedupeKey: `ep:${d.id}:${current.season}:${current.episode}`,
        type: single ? "new-episode" : "new-episodes",
        category: "episodes",
        season: current.season,
        episode: single ? current.episode : from,
        ...(single ? {} : { episodeTo: current.episode }),
        title: `${d.name}: new episode${single ? "" : "s"}`,
        body: single
          ? `S${current.season} E${current.episode}${name ? ` · ${name}` : ""} is out.`
          : `Season ${current.season}, episodes ${from}–${current.episode} are out.`,
        eventDate: current.airDate,
        url: tvUrl(d.id, current.season),
        priority: "normal",
        ttlDays: 60,
      });
    }
    // Corrections (an episode withdrawn, renumbered) simply move the snapshot; dedupe keys prevent repeats.
    lastAired = current;
  }

  return {
    snapshot: { title: d.name, firstSeen: prev.firstSeen, checkedAt: nowIso, ...(lastAired ? { lastAired } : {}), seasons: nextSeasons },
    events,
  };
}

// --- Films ---------------------------------------------------------------------------------------

/** TMDB release types: 1 premiere, 2 limited theatrical, 3 theatrical, 4 digital, 5 physical, 6 TV. */
export type ReleaseKind = "premiere" | "theatrical-limited" | "theatrical" | "digital" | "physical" | "tv";
const KIND_BY_TYPE: Record<number, ReleaseKind> = { 1: "premiere", 2: "theatrical-limited", 3: "theatrical", 4: "digital", 5: "physical", 6: "tv" };

export interface TmdbMovieDetails {
  id: number;
  title: string;
  poster_path?: string | null;
  release_date?: string;
  genres?: Array<{ id: number; name: string }>;
  release_dates?: { results: Array<{ iso_3166_1: string; release_dates: Array<{ type: number; release_date: string; certification?: string }> }> };
  "watch/providers"?: { results: Record<string, { link?: string; flatrate?: Array<{ provider_id: number; provider_name: string }> }> };
}

/**
 * Earliest date of each release type in one region. Regions are never mixed: a digital release in
 * the US says nothing about the UK, and theatrical, digital, physical and streaming availability are
 * separate facts.
 */
export function classifyReleases(d: TmdbMovieDetails, region: string): Partial<Record<ReleaseKind, string>> {
  const out: Partial<Record<ReleaseKind, string>> = {};
  const entry = d.release_dates?.results.find((r) => r.iso_3166_1 === region);
  for (const r of entry?.release_dates ?? []) {
    const kind = KIND_BY_TYPE[r.type];
    const t = dateMs(r.release_date);
    if (!kind || t === null) continue;
    const day = isoDate(t);
    if (!out[kind] || day < out[kind]!) out[kind] = day;
  }
  return out;
}

/** Subscription streaming services in a region (TMDB data from JustWatch). */
export function streamingProviders(d: TmdbMovieDetails, region: string): Array<{ id: number; name: string }> {
  return (d["watch/providers"]?.results?.[region]?.flatrate ?? []).map((p) => ({ id: p.provider_id, name: p.provider_name }));
}

export function movieCertification(d: TmdbMovieDetails): string | null {
  const us = d.release_dates?.results.find((r) => r.iso_3166_1 === "US")?.release_dates ?? [];
  const ranked = [...us].sort((a, b) => Number(b.type === 3 || b.type === 2) - Number(a.type === 3 || a.type === 2));
  return ranked.find((r) => r.certification?.trim())?.certification?.trim() || null;
}

export interface MovieSnapshot {
  firstSeen: string;
  checkedAt: string;
  digital?: string;
  physical?: string;
  providers: number[];
  notified: { digital?: boolean; physical?: boolean };
}

const movieUrl = (id: number) => `/browse?title=tmdb-${id}`;

/** One release notification (shared by followed films and popular new releases). */
export function releaseNotification(d: TmdbMovieDetails, kind: "digital" | "physical", date: string, region: string): NotificationContent {
  return {
    dedupeKey: `${kind}:${d.id}:${region}`,
    type: kind === "digital" ? "digital-release" : "physical-release",
    category: kind,
    tmdbId: d.id,
    mediaType: "movie",
    name: d.title,
    title: kind === "digital" ? `${d.title}: out digitally` : `${d.title}: out on Blu-ray & DVD`,
    // Says what TMDB reports; never that it can be played here (that depends on available releases).
    body:
      kind === "digital"
        ? `Released to buy or rent digitally in ${region} on ${formatDate(date)}.`
        : `Released on disc in ${region} on ${formatDate(date)}.`,
    image: d.poster_path ?? undefined,
    eventDate: date,
    url: movieUrl(d.id),
    source: "tmdb",
    region,
    priority: "normal",
    certification: movieCertification(d),
    subject: `movie:${d.id}`,
    ttlDays: 60,
  };
}

/** Release changes of a followed film in one region since the last snapshot. */
export function detectMovie(prev: MovieSnapshot | undefined, d: TmdbMovieDetails, region: string, now: Date): { snapshot: MovieSnapshot; events: NotificationContent[] } {
  const rel = classifyReleases(d, region);
  const providers = streamingProviders(d, region);
  const nowIso = now.toISOString();
  const released = (kind: "digital" | "physical") => isAvailable(rel[kind], now);
  if (!prev) {
    return {
      snapshot: {
        firstSeen: nowIso,
        checkedAt: nowIso,
        ...(rel.digital ? { digital: rel.digital } : {}),
        ...(rel.physical ? { physical: rel.physical } : {}),
        providers: providers.map((p) => p.id),
        // Already out when first seen: part of the baseline, never announced.
        notified: { digital: released("digital"), physical: released("physical") },
      },
      events: [],
    };
  }
  const events: NotificationContent[] = [];
  const notified = { ...prev.notified };
  for (const kind of ["digital", "physical"] as const) {
    if (notified[kind] || !released(kind)) continue;
    notified[kind] = true;
    if (isRecent(rel[kind], now, RELEASE_RECENT_DAYS)) events.push(releaseNotification(d, kind, rel[kind]!, region));
  }
  const added = providers.filter((p) => !prev.providers.includes(p.id));
  if (added.length) {
    const names = added.map((p) => p.name);
    events.push({
      dedupeKey: `stream:${d.id}:${region}:${added.map((p) => p.id).sort((a, b) => a - b).join(",")}`,
      type: "streaming-available",
      category: "digital",
      tmdbId: d.id,
      mediaType: "movie",
      name: d.title,
      title: `${d.title}: now streaming`,
      body: `Now on ${names.slice(0, 3).join(", ")}${names.length > 3 ? " and more" : ""} in ${region}. Streaming data: JustWatch.`,
      image: d.poster_path ?? undefined,
      url: movieUrl(d.id),
      source: "justwatch-via-tmdb",
      region,
      priority: "normal",
      certification: movieCertification(d),
      subject: `movie:${d.id}`,
      ttlDays: 45,
    });
  }
  return {
    snapshot: {
      firstSeen: prev.firstSeen,
      checkedAt: nowIso,
      ...(rel.digital ? { digital: rel.digital } : {}),
      ...(rel.physical ? { physical: rel.physical } : {}),
      providers: providers.map((p) => p.id),
      notified,
    },
    events,
  };
}

// --- Interests, trending, recommendations ------------------------------------------------------

export interface Seed {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  genreIds: number[];
  /** Recently watched counts more than "on my list". */
  weight: number;
  kind: "watched" | "list";
}

export interface Candidate {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  genreIds: number[];
  posterPath?: string;
  vote?: number;
  adult?: boolean;
  certification?: string | null;
}

export type Interest = Map<number, number>;

/** Genre affinity from what the profile watched and saved; weights sum to 1. */
export function buildInterest(seeds: Seed[]): Interest {
  const raw = new Map<number, number>();
  for (const s of seeds) for (const g of s.genreIds) raw.set(g, (raw.get(g) ?? 0) + s.weight);
  const total = [...raw.values()].reduce((a, b) => a + b, 0);
  return new Map([...raw].map(([g, w]) => [g, total ? w / total : 0]));
}

export function interestScore(genreIds: number[], interest: Interest): number {
  return genreIds.reduce((sum, g) => sum + (interest.get(g) ?? 0), 0);
}

export const titleKey = (c: { mediaType: "movie" | "tv"; tmdbId: number }) => `${c.mediaType}:${c.tmdbId}`;

/**
 * Trending titles worth telling this profile about: matching its interests (any genre in common)
 * when it has a history, otherwise only the very top title. Excludes anything it has seen, saved,
 * dismissed or been told about. Deterministic order.
 */
export function rankTrending(candidates: Candidate[], interest: Interest, exclude: Set<string>, limit: number): Candidate[] {
  const hasInterest = interest.size > 0;
  const n = candidates.length || 1;
  const scored = candidates
    .map((c, rank) => ({ c, match: interestScore(c.genreIds, interest), rank }))
    .filter(({ c, match }) => !c.adult && c.posterPath && !exclude.has(titleKey(c)) && (!hasInterest || match > 0))
    .map(({ c, match, rank }) => ({ c, score: 3 * match + (1 - rank / n) + (c.vote ?? 0) / 20 }))
    .sort((a, b) => b.score - a.score || a.c.tmdbId - b.c.tmdbId);
  return scored.slice(0, hasInterest ? limit : Math.min(1, limit)).map((s) => s.c);
}

export interface Recommendation extends Candidate {
  reason: string;
}

/**
 * Explainable recommendations: titles TMDB recommends for several of the profile's seeds rank
 * higher (each seed contributes weight / (position + 1)), plus genre affinity and rating. The
 * reason names the seed that contributed most.
 */
export function rankRecommendations(
  bySeed: Array<{ seed: Seed; recs: Candidate[] }>,
  interest: Interest,
  exclude: Set<string>,
  limit: number
): Recommendation[] {
  const acc = new Map<string, { c: Candidate; score: number; best: { seed: Seed; part: number } }>();
  for (const { seed, recs } of bySeed) {
    recs.forEach((c, i) => {
      if (c.adult || !c.posterPath || exclude.has(titleKey(c))) return;
      const part = seed.weight / (i + 1);
      const key = titleKey(c);
      const cur = acc.get(key);
      if (cur) {
        cur.score += part;
        if (part > cur.best.part) cur.best = { seed, part };
      } else acc.set(key, { c, score: part, best: { seed, part } });
    });
  }
  return [...acc.values()]
    .map((e) => ({ ...e, total: e.score + 0.5 * interestScore(e.c.genreIds, interest) + (e.c.vote ?? 0) / 20 }))
    .sort((a, b) => b.total - a.total || a.c.tmdbId - b.c.tmdbId)
    .slice(0, limit)
    .map((e) => ({ ...e.c, reason: `${e.best.seed.kind === "watched" ? "Because you watched" : "Because you saved"} ${e.best.seed.title}` }));
}

export const titleUrl = (c: { mediaType: "movie" | "tv"; tmdbId: number }) => (c.mediaType === "tv" ? tvUrl(c.tmdbId) : movieUrl(c.tmdbId));
