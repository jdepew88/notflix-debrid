/**
 * The notification background jobs. Each job reads the accounts' profiles (My List, Continue
 * Watching, preferences; never written here), asks TMDB through the rate-limited client, compares
 * with the stored snapshots and delivers notifications to the profiles concerned. Everything is
 * bounded: a fixed maximum of titles per run, of candidates per profile and of notifications per
 * profile and day, so neither a large library nor a bulk metadata update can flood anyone.
 *
 * Dependencies are passed in (JobContext) so tests run the real jobs against mocked TMDB answers,
 * fixed dates and a throwaway data folder.
 */
import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "../install/store.mjs";
import { certificationAllowed, type MaturityLevel } from "../maturity";
import {
  buildInterest,
  classifyReleases,
  detectMovie,
  detectSeries,
  isAvailable,
  isRecent,
  isoDate,
  movieCertification,
  rankRecommendations,
  rankTrending,
  releaseNotification,
  titleKey,
  titleUrl,
  type Candidate,
  type MovieSnapshot,
  type Seed,
  type SeriesSnapshot,
  type TmdbMovieDetails,
  type TmdbTvDetails,
} from "./detect";
import { categoryEnabled, effectiveRegion, inQuietHours, type NotificationPreferences } from "./preferences";
import {
  deliver,
  hasKey,
  listInboxAccounts,
  pendingPushes,
  pruneInbox,
  readProfileInbox,
  removeInbox,
  setPushState,
  updateInboxFile,
  type ProfileInbox,
} from "./store";
import { listSubscriptions, recordDelivery, removeSubscriptionsWhere } from "./subscriptions";
import { TmdbAuthError, type TmdbClient } from "./tmdb-client";
import type { NotificationContent } from "./types";
import { sendPush, type VapidKeys } from "./webpush";

// --- Context ---------------------------------------------------------------------------------------

export interface ProfileView {
  id: string;
  name: string;
  isKids: boolean;
  maturity: MaturityLevel;
  prefs: NotificationPreferences;
  /** My List ids ("tmdb-123", "tmdb-tv-123"). */
  myList: string[];
  /** Continue Watching / history, newest first. */
  watched: Array<{ tmdbId: number; mediaType: "movie" | "tv"; title: string; at: number }>;
}

export interface AccountView {
  id: string;
  role: "owner" | "admin" | "user";
  profiles: ProfileView[];
  /** Current session version (bumped when the account is signed out everywhere). */
  sessionVersion?: number;
}

export interface ServiceAlert {
  id: string;
  message: string;
  href: string;
}

export interface JobContext {
  /** <data>/db/notifications */
  dir: string;
  now: () => Date;
  /** null when no TMDB key is stored (TMDB-based jobs are skipped). */
  tmdb: TmdbClient | null;
  accounts: () => AccountView[];
  log: (message: string) => void;
  serviceAlerts?: () => Promise<ServiceAlert[]>;
  push?: { keys: VapidKeys; subject: string; fetchImpl?: typeof fetch } | null;
}

export type JobName = "series" | "releases" | "trending" | "recommendations" | "service" | "cleanup";

export interface JobOutcome {
  summary: string;
}

// --- Shared state (snapshots) -------------------------------------------------------------------

export interface JobState {
  lastRunAt?: string;
  lastSuccessAt?: string;
  nextRunAt?: string;
  failures: number;
  lastError?: string;
  lastSummary?: string;
}

export interface NotificationState {
  version: number;
  series: Record<string, SeriesSnapshot>;
  movies: Record<string, MovieSnapshot>;
  jobs: Record<string, JobState>;
  /** Active service alerts: id → day it became active (part of the dedupe key). */
  service: Record<string, string>;
}

const stateFile = (dir: string) => path.join(dir, "state.json");

export function readState(dir: string): NotificationState {
  const raw = readJson(stateFile(dir), null) as Partial<NotificationState> | null;
  const obj = <T>(v: unknown): Record<string, T> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {});
  return { version: 1, series: obj(raw?.series), movies: obj(raw?.movies), jobs: obj(raw?.jobs), service: obj(raw?.service) };
}

export function updateState<T>(dir: string, fn: (s: NotificationState) => T): T {
  return withFileLock(`${stateFile(dir)}.lock`, () => {
    const s = readState(dir);
    const result = fn(s);
    writeJsonAtomic(stateFile(dir), s);
    return result;
  });
}

// --- Helpers ---------------------------------------------------------------------------------------

/** Bounds per run (see the module comment). */
export const LIMITS = { series: 300, movies: 300, seeds: 8, trendingInstant: 2, digestItems: 5, recsInstant: 3, discovery: 8, discoveryPerProfile: 2 };
const WATCH_WINDOW_MS = 120 * 86_400_000;

function profileAllows(profile: ProfileView) {
  // Digest items are filtered per profile before the digest is built.
  return (c: NotificationContent) => c.category === "service" || c.type === "digest" || certificationAllowed(c.certification ?? null, profile.maturity);
}

function deliverTo(ctx: JobContext, account: AccountView, profile: ProfileView, contents: NotificationContent[]) {
  if (!contents.length) return 0;
  const hasPush = profile.prefs.browser && listSubscriptions(ctx.dir, { accountId: account.id, profileId: profile.id }).length > 0;
  const r = deliver(ctx.dir, account.id, profile.id, contents, {
    now: ctx.now(),
    enabled: (c) => categoryEnabled(profile.prefs, c),
    allowed: profileAllows(profile),
    push: hasPush,
  });
  return r.delivered.length;
}

const parseListId = (id: string): { tmdbId: number; mediaType: "movie" | "tv" } | null => {
  let m = /^tmdb-tv-(\d+)$/.exec(id);
  if (m) return { tmdbId: Number(m[1]), mediaType: "tv" };
  m = /^tmdb-(\d+)$/.exec(id);
  return m ? { tmdbId: Number(m[1]), mediaType: "movie" } : null;
};

/** Series a profile follows: explicit follows, My List, recently watched; minus unfollowed. */
export function followedSeries(profile: ProfileView, inbox: ProfileInbox, now: Date): Map<number, number> {
  const out = new Map<number, number>(); // tmdbId → recency (ms) for prioritising
  const add = (id: number, at: number) => out.set(id, Math.max(out.get(id) ?? 0, at));
  for (const [key, f] of Object.entries(inbox.follows)) {
    const m = /^tv:(\d+)$/.exec(key);
    if (m) add(Number(m[1]), f.at);
  }
  for (const id of profile.myList) {
    const p = parseListId(id);
    if (p?.mediaType === "tv") add(p.tmdbId, 0);
  }
  for (const w of profile.watched) if (w.mediaType === "tv" && now.getTime() - w.at < WATCH_WINDOW_MS) add(w.tmdbId, w.at);
  for (const key of Object.keys(inbox.muted)) {
    const m = /^tv:(\d+)$/.exec(key);
    if (m && !inbox.follows[key]) out.delete(Number(m[1]));
  }
  return out;
}

function* profilesOf(accounts: AccountView[]) {
  for (const account of accounts) for (const profile of account.profiles) yield { account, profile };
}

/** Titles the profile already has, watched, saved or dismissed. */
function excludedTitles(profile: ProfileView, inbox: ProfileInbox): Set<string> {
  const out = new Set<string>(Object.keys(inbox.suppressed));
  for (const id of profile.myList) {
    const p = parseListId(id);
    if (p) out.add(titleKey(p));
  }
  for (const w of profile.watched) out.add(titleKey(w));
  for (const key of Object.keys(inbox.keys)) {
    const m = /^(?:trending|rec):(movie|tv):(\d+)$/.exec(key);
    if (m) out.add(`${m[1]}:${m[2]}`);
  }
  return out;
}

interface TmdbListItem {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  genre_ids?: number[];
  poster_path?: string | null;
  vote_average?: number;
  adult?: boolean;
}

function toCandidate(r: TmdbListItem, media?: "movie" | "tv"): Candidate | null {
  const mediaType = media ?? (r.media_type === "tv" ? "tv" : r.media_type === "movie" ? "movie" : null);
  if (!mediaType) return null;
  return {
    tmdbId: r.id,
    mediaType,
    title: (mediaType === "tv" ? r.name : r.title) ?? r.title ?? r.name ?? "",
    genreIds: r.genre_ids ?? [],
    posterPath: r.poster_path ?? undefined,
    vote: r.vote_average,
    adult: r.adult,
  };
}

async function seedsFor(ctx: JobContext, profile: ProfileView): Promise<Seed[]> {
  const tmdb = ctx.tmdb!;
  const picks: Array<{ tmdbId: number; mediaType: "movie" | "tv"; title?: string; weight: number; kind: Seed["kind"] }> = [];
  const seen = new Set<string>();
  for (const w of profile.watched) {
    if (picks.length >= LIMITS.seeds) break;
    const key = titleKey(w);
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push({ tmdbId: w.tmdbId, mediaType: w.mediaType, title: w.title, weight: 2, kind: "watched" });
  }
  for (const id of [...profile.myList].reverse()) {
    if (picks.length >= LIMITS.seeds) break;
    const p = parseListId(id);
    if (!p || seen.has(titleKey(p))) continue;
    seen.add(titleKey(p));
    picks.push({ ...p, weight: 1, kind: "list" });
  }
  const seeds: Seed[] = [];
  for (const p of picks) {
    try {
      const d = await tmdb.get<{ title?: string; name?: string; genres?: Array<{ id: number }> }>(`/${p.mediaType}/${p.tmdbId}`, 24 * 3_600_000);
      seeds.push({ tmdbId: p.tmdbId, mediaType: p.mediaType, title: p.title || d.title || d.name || "", genreIds: (d.genres ?? []).map((g) => g.id), weight: p.weight, kind: p.kind });
    } catch (err) {
      if (err instanceof TmdbAuthError) throw err;
    }
  }
  return seeds;
}

/** US certification of a candidate (only fetched for restricted profiles). */
async function certificationOf(ctx: JobContext, c: Candidate): Promise<string | null> {
  try {
    if (c.mediaType === "tv") {
      const d = await ctx.tmdb!.get<{ results: Array<{ iso_3166_1: string; rating: string }> }>(`/tv/${c.tmdbId}/content_ratings`, 7 * 86_400_000);
      return d.results.find((r) => r.iso_3166_1 === "US")?.rating?.trim() || null;
    }
    const d = await ctx.tmdb!.get<TmdbMovieDetails>(`/movie/${c.tmdbId}?append_to_response=release_dates`, 7 * 86_400_000);
    return movieCertification(d);
  } catch (err) {
    if (err instanceof TmdbAuthError) throw err;
    return null;
  }
}

async function withCertifications(ctx: JobContext, profile: ProfileView, list: Candidate[]): Promise<Candidate[]> {
  if (profile.maturity === "all") return list;
  const out: Candidate[] = [];
  for (const c of list) {
    const certification = c.certification !== undefined ? c.certification : await certificationOf(ctx, c);
    if (certificationAllowed(certification, profile.maturity)) out.push({ ...c, certification });
  }
  return out;
}

function today(now: Date) {
  return isoDate(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// --- Jobs ------------------------------------------------------------------------------------------

/** New episodes and seasons of followed series. */
export async function runSeriesJob(ctx: JobContext): Promise<JobOutcome> {
  if (!ctx.tmdb) return { summary: "skipped: no TMDB key" };
  const now = ctx.now();
  const accounts = ctx.accounts();
  const followers = new Map<number, Array<{ account: AccountView; profile: ProfileView }>>();
  const recency = new Map<number, number>();
  for (const { account, profile } of profilesOf(accounts)) {
    if (!profile.prefs.episodes && !profile.prefs.seasons) continue;
    const inbox = readProfileInbox(ctx.dir, account.id, profile.id);
    for (const [id, at] of followedSeries(profile, inbox, now)) {
      followers.set(id, [...(followers.get(id) ?? []), { account, profile }]);
      recency.set(id, Math.max(recency.get(id) ?? 0, at));
    }
  }
  const ids = [...followers.keys()].sort((a, b) => (recency.get(b) ?? 0) - (recency.get(a) ?? 0) || a - b).slice(0, LIMITS.series);
  const previous = readState(ctx.dir).series;
  const updated: Record<string, SeriesSnapshot> = {};
  let failed = 0;
  let delivered = 0;
  for (const id of ids) {
    let d: TmdbTvDetails;
    try {
      d = await ctx.tmdb.get<TmdbTvDetails>(`/tv/${id}?append_to_response=content_ratings`, 3 * 3_600_000);
    } catch (err) {
      if (err instanceof TmdbAuthError) throw err;
      failed++;
      continue;
    }
    const { snapshot, events } = detectSeries(previous[String(id)], d, now);
    updated[String(id)] = snapshot;
    for (const { account, profile } of followers.get(id)!) delivered += deliverTo(ctx, account, profile, events);
  }
  updateState(ctx.dir, (s) => Object.assign(s.series, updated));
  if (ids.length && failed === ids.length) throw new Error(`TMDB did not answer for any of ${ids.length} series`);
  return { summary: `${ids.length} series checked, ${failed} failed, ${delivered} notifications` };
}

/** Digital and physical releases and streaming availability, in each profile's region. */
export async function runReleasesJob(ctx: JobContext): Promise<JobOutcome> {
  if (!ctx.tmdb) return { summary: "skipped: no TMDB key" };
  const now = ctx.now();
  const accounts = ctx.accounts();
  const wanted = (p: ProfileView) => p.prefs.digital || p.prefs.physical;
  // Followed films (My List) per region.
  const followers = new Map<number, Array<{ account: AccountView; profile: ProfileView; region: string }>>();
  for (const { account, profile } of profilesOf(accounts)) {
    if (!wanted(profile)) continue;
    for (const id of profile.myList) {
      const p = parseListId(id);
      if (p?.mediaType === "movie") followers.set(p.tmdbId, [...(followers.get(p.tmdbId) ?? []), { account, profile, region: effectiveRegion(profile.prefs) }]);
    }
  }
  const ids = [...followers.keys()].sort((a, b) => a - b).slice(0, LIMITS.movies);
  const previous = readState(ctx.dir).movies;
  const updated: Record<string, MovieSnapshot> = {};
  let failed = 0;
  let delivered = 0;
  const details = async (id: number) => ctx.tmdb!.get<TmdbMovieDetails>(`/movie/${id}?append_to_response=release_dates,watch/providers`, 6 * 3_600_000);
  for (const id of ids) {
    let d: TmdbMovieDetails;
    try {
      d = await details(id);
    } catch (err) {
      if (err instanceof TmdbAuthError) throw err;
      failed++;
      continue;
    }
    const regions = [...new Set(followers.get(id)!.map((f) => f.region))];
    for (const region of regions) {
      const key = `${id}:${region}`;
      const { snapshot, events } = detectMovie(previous[key], d, region, now);
      updated[key] = snapshot;
      for (const f of followers.get(id)!.filter((x) => x.region === region)) delivered += deliverTo(ctx, f.account, f.profile, events);
    }
  }
  // Popular new releases (discovery): checked against the region's actual release dates.
  const day = today(now);
  const weekAgo = isoDate(Date.parse(day) - 7 * 86_400_000);
  const regions = new Map<string, Array<{ account: AccountView; profile: ProfileView }>>();
  for (const { account, profile } of profilesOf(accounts)) {
    if (wanted(profile)) regions.set(effectiveRegion(profile.prefs), [...(regions.get(effectiveRegion(profile.prefs)) ?? []), { account, profile }]);
  }
  for (const [region, members] of regions) {
    for (const kind of ["digital", "physical"] as const) {
      const interested = members.filter((m) => m.profile.prefs[kind]);
      if (!interested.length) continue;
      let list: { results: TmdbListItem[] };
      try {
        list = await ctx.tmdb.get(
          `/discover/movie?region=${region}&with_release_type=${kind === "digital" ? 4 : 5}&release_date.gte=${weekAgo}&release_date.lte=${day}&sort_by=popularity.desc&vote_count.gte=10&include_adult=false`,
          12 * 3_600_000
        );
      } catch (err) {
        if (err instanceof TmdbAuthError) throw err;
        failed++;
        continue;
      }
      const verified: Array<{ content: NotificationContent; candidate: Candidate }> = [];
      for (const r of list.results.slice(0, LIMITS.discovery)) {
        try {
          const d = await details(r.id);
          const date = classifyReleases(d, region)[kind];
          // Only a real release of this kind, in this region, within the last week.
          if (!date || !isAvailable(date, now) || !isRecent(date, now, 8)) continue;
          const candidate = toCandidate(r, "movie")!;
          verified.push({ content: releaseNotification(d, kind, date, region), candidate: { ...candidate, genreIds: (d.genres ?? []).map((g) => g.id) } });
        } catch (err) {
          if (err instanceof TmdbAuthError) throw err;
        }
      }
      for (const { account, profile } of interested) {
        const inbox = readProfileInbox(ctx.dir, account.id, profile.id);
        const seeds = await seedsFor(ctx, profile);
        const ranked = rankTrending(
          verified.map((v) => v.candidate),
          buildInterest(seeds),
          excludedTitles(profile, inbox),
          LIMITS.discoveryPerProfile
        );
        const pick = verified.filter((v) => ranked.some((c) => c.tmdbId === v.candidate.tmdbId) && !hasKey(inbox, v.content.dedupeKey));
        delivered += deliverTo(ctx, account, profile, pick.map((v) => ({ ...v.content, priority: "low" as const })));
      }
    }
  }
  updateState(ctx.dir, (s) => Object.assign(s.movies, updated));
  if (ids.length && failed >= ids.length) throw new Error(`TMDB did not answer for any of ${ids.length} films`);
  return { summary: `${ids.length} films checked in ${regions.size} region(s), ${failed} failed, ${delivered} notifications` };
}

/** Builds and delivers trending or recommendation notifications for one profile. */
function suggestionContents(
  kind: "trending" | "recommendations",
  profile: ProfileView,
  picks: Array<Candidate & { reason?: string }>,
  now: Date
): NotificationContent[] {
  if (!picks.length) return [];
  const prefix = kind === "trending" ? "trending" : "rec";
  if (profile.prefs.digest === "daily") {
    const day = today(now);
    const items = picks.slice(0, LIMITS.digestItems);
    const names = items.map((i) => i.title);
    return [
      {
        dedupeKey: `digest:${kind}:${day}`,
        type: "digest",
        category: kind,
        title: kind === "trending" ? "Trending this week" : "Picked for you",
        body: `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` and ${names.length - 2} more` : ""}`,
        image: items[0].posterPath,
        url: "/browse/notifications",
        source: "tmdb",
        priority: "low",
        // Every item already passed the profile's maturity filter.
        certification: undefined,
        items: items.map((i) => ({ tmdbId: i.tmdbId, mediaType: i.mediaType, title: i.title, image: i.posterPath, url: titleUrl(i), ...(i.reason ? { reason: i.reason } : {}) })),
        ttlDays: 14,
      },
    ];
  }
  return picks.map((c) => ({
    dedupeKey: `${prefix}:${titleKey(c)}`,
    type: kind === "trending" ? ("trending" as const) : ("recommendation" as const),
    category: kind,
    tmdbId: c.tmdbId,
    mediaType: c.mediaType,
    name: c.title,
    title: kind === "trending" ? `Trending: ${c.title}` : c.title,
    body: c.reason ?? (kind === "trending" ? "Popular this week and close to what you watch." : "Recommended for you."),
    image: c.posterPath,
    url: titleUrl(c),
    source: "tmdb" as const,
    priority: "low" as const,
    certification: c.certification,
    subject: titleKey(c),
    ttlDays: 14,
  }));
}

/** Remembers digest items so they are not suggested again. */
function markSuggested(ctx: JobContext, accountId: string, profileId: string, kind: "trending" | "recommendations", picks: Candidate[]) {
  const prefix = kind === "trending" ? "trending" : "rec";
  const at = ctx.now().getTime();
  updateInboxFile(ctx.dir, accountId, (data) => {
    const inbox = data.profiles[profileId];
    if (!inbox) return;
    for (const c of picks) inbox.keys[`${prefix}:${titleKey(c)}`] ??= at;
  });
}

export async function runTrendingJob(ctx: JobContext): Promise<JobOutcome> {
  if (!ctx.tmdb) return { summary: "skipped: no TMDB key" };
  const now = ctx.now();
  const list = await ctx.tmdb.get<{ results: TmdbListItem[] }>("/trending/all/week", 6 * 3_600_000);
  const candidates = list.results.map((r) => toCandidate(r)).filter((c): c is Candidate => c !== null);
  let delivered = 0;
  for (const { account, profile } of profilesOf(ctx.accounts())) {
    if (!profile.prefs.trending) continue;
    const inbox = readProfileInbox(ctx.dir, account.id, profile.id);
    if (profile.prefs.digest === "daily" && hasKey(inbox, `digest:trending:${today(now)}`)) continue;
    const interest = buildInterest(await seedsFor(ctx, profile));
    const limit = profile.prefs.digest === "daily" ? LIMITS.digestItems : LIMITS.trendingInstant;
    const ranked = await withCertifications(ctx, profile, rankTrending(candidates, interest, excludedTitles(profile, inbox), limit + 3));
    const picks = ranked.slice(0, limit);
    const n = deliverTo(ctx, account, profile, suggestionContents("trending", profile, picks, now));
    if (n && profile.prefs.digest === "daily") markSuggested(ctx, account.id, profile.id, "trending", picks);
    delivered += n;
  }
  return { summary: `${candidates.length} trending titles, ${delivered} notifications` };
}

export async function runRecommendationsJob(ctx: JobContext): Promise<JobOutcome> {
  if (!ctx.tmdb) return { summary: "skipped: no TMDB key" };
  const now = ctx.now();
  let delivered = 0;
  let profiles = 0;
  for (const { account, profile } of profilesOf(ctx.accounts())) {
    if (!profile.prefs.recommendations) continue;
    const inbox = readProfileInbox(ctx.dir, account.id, profile.id);
    if (profile.prefs.digest === "daily" && hasKey(inbox, `digest:recommendations:${today(now)}`)) continue;
    const seeds = (await seedsFor(ctx, profile)).slice(0, 5);
    if (!seeds.length) continue;
    profiles++;
    const bySeed: Array<{ seed: Seed; recs: Candidate[] }> = [];
    for (const seed of seeds) {
      try {
        const r = await ctx.tmdb.get<{ results: TmdbListItem[] }>(`/${seed.mediaType}/${seed.tmdbId}/recommendations`, 24 * 3_600_000);
        bySeed.push({ seed, recs: r.results.map((x) => toCandidate(x, seed.mediaType)).filter((c): c is Candidate => c !== null) });
      } catch (err) {
        if (err instanceof TmdbAuthError) throw err;
      }
    }
    const limit = profile.prefs.digest === "daily" ? LIMITS.digestItems : LIMITS.recsInstant;
    const ranked = rankRecommendations(bySeed, buildInterest(seeds), excludedTitles(profile, inbox), limit + 3);
    const allowed = await withCertifications(ctx, profile, ranked);
    const picks = ranked.filter((r) => allowed.some((a) => a.tmdbId === r.tmdbId && a.mediaType === r.mediaType)).slice(0, limit)
      .map((r) => ({ ...r, certification: allowed.find((a) => a.tmdbId === r.tmdbId && a.mediaType === r.mediaType)?.certification }));
    const n = deliverTo(ctx, account, profile, suggestionContents("recommendations", profile, picks, now));
    if (n && profile.prefs.digest === "daily") markSuggested(ctx, account.id, profile.id, "recommendations", picks);
    delivered += n;
  }
  return { summary: `${profiles} profile(s) with a history, ${delivered} notifications` };
}

/** Service notifications for the owner and administrators (not their kids profiles). */
export function deliverServiceNotice(ctx: JobContext, alert: ServiceAlert, activeSince: string): number {
  let delivered = 0;
  const content: NotificationContent = {
    dedupeKey: `svc:${alert.id}:${activeSince}`,
    type: "service",
    category: "service",
    title: "Notflix needs attention",
    body: alert.message,
    url: alert.href.startsWith("/") && !alert.href.startsWith("//") ? alert.href : "/settings",
    source: "notflix",
    priority: "high",
    audience: "admins",
    ttlDays: 30,
  };
  for (const account of ctx.accounts()) {
    if (account.role !== "owner" && account.role !== "admin") continue;
    for (const profile of account.profiles) if (!profile.isKids && profile.maturity === "all") delivered += deliverTo(ctx, account, profile, [content]);
  }
  return delivered;
}

export async function runServiceJob(ctx: JobContext): Promise<JobOutcome> {
  if (!ctx.serviceAlerts) return { summary: "skipped" };
  const alerts = await ctx.serviceAlerts();
  const day = today(ctx.now());
  const active = updateState(ctx.dir, (s) => {
    const next: Record<string, string> = {};
    for (const a of alerts) next[a.id] = s.service[a.id] ?? day;
    // Job-failure notices are managed by the scheduler; keep them.
    for (const [id, since] of Object.entries(s.service)) if (id.startsWith("job-")) next[id] = since;
    s.service = next;
    return next;
  });
  let delivered = 0;
  for (const a of alerts) delivered += deliverServiceNotice(ctx, a, active[a.id]);
  return { summary: `${alerts.length} active alert(s), ${delivered} notifications` };
}

/** Retention: expired notifications, removed profiles/accounts, stale snapshots, dead subscriptions. */
export async function runCleanupJob(ctx: JobContext): Promise<JobOutcome> {
  const now = ctx.now();
  const accounts = ctx.accounts();
  const live = new Map(accounts.map((a) => [a.id, new Set(a.profiles.map((p) => p.id))]));
  let removed = 0;
  for (const accountId of listInboxAccounts(ctx.dir)) {
    if (!live.has(accountId)) {
      removeInbox(ctx.dir, accountId);
      continue;
    }
    removed += pruneInbox(ctx.dir, accountId, live.get(accountId)!, now).removed;
  }
  const staleBefore = now.getTime() - 60 * 86_400_000;
  updateState(ctx.dir, (s) => {
    for (const [k, v] of Object.entries(s.series)) if (Date.parse(v.checkedAt) < staleBefore) delete s.series[k];
    for (const [k, v] of Object.entries(s.movies)) if (Date.parse(v.checkedAt) < staleBefore) delete s.movies[k];
  });
  const subs = removeSubscriptionsWhere(ctx.dir, (s) => !live.get(s.accountId)?.has(s.profileId));
  return { summary: `${removed} expired notification(s) removed, ${subs} orphaned subscription(s) removed` };
}

export const JOBS: Record<JobName, { intervalMs: number; run: (ctx: JobContext) => Promise<JobOutcome> }> = {
  series: { intervalMs: 6 * 3_600_000, run: runSeriesJob },
  releases: { intervalMs: 12 * 3_600_000, run: runReleasesJob },
  trending: { intervalMs: 24 * 3_600_000, run: runTrendingJob },
  recommendations: { intervalMs: 24 * 3_600_000, run: runRecommendationsJob },
  service: { intervalMs: 6 * 3_600_000, run: runServiceJob },
  cleanup: { intervalMs: 24 * 3_600_000, run: runCleanupJob },
};

// --- Browser push dispatch ---------------------------------------------------------------------

/** Pushes older than this are not sent any more (the in-app notification remains). */
const PUSH_MAX_AGE_MS = 24 * 3_600_000;
/** Per profile and hour; extra notifications stay in-app only. */
export const PUSH_PER_HOUR = 6;

/**
 * Sends queued browser pushes: respects quiet hours (held until they end), drops stale ones, caps
 * the rate, and removes subscriptions the push service reports as gone. The payload carries only
 * the notification's title, text and in-app link: never credentials or stream information.
 */
export async function dispatchPushes(ctx: JobContext): Promise<{ sent: number; held: number; skipped: number }> {
  const result = { sent: 0, held: 0, skipped: 0 };
  if (!ctx.push) return result;
  const pending = pendingPushes(ctx.dir);
  if (!pending.length) return result;
  const now = ctx.now();
  const accounts = ctx.accounts();
  const profiles = new Map<string, ProfileView>();
  for (const { account, profile } of profilesOf(accounts)) profiles.set(`${account.id}/${profile.id}`, profile);
  // Browsers registered before the account was signed out everywhere (password change) are dropped.
  const versions = new Map(accounts.map((a) => [a.id, a.sessionVersion ?? 0]));
  removeSubscriptionsWhere(ctx.dir, (s) => versions.has(s.accountId) && (s.sessionVersion ?? 0) !== versions.get(s.accountId));
  const sentThisHour = new Map<string, number>();
  for (const { accountId, profileId, item } of pending) {
    const profile = profiles.get(`${accountId}/${profileId}`);
    const subs = listSubscriptions(ctx.dir, { accountId, profileId });
    const key = `${accountId}/${profileId}`;
    if (!profile || !profile.prefs.browser || !subs.length || item.readAt || item.dismissedAt || now.getTime() - Date.parse(item.createdAt) > PUSH_MAX_AGE_MS) {
      setPushState(ctx.dir, accountId, profileId, item.id, "skipped");
      result.skipped++;
      continue;
    }
    if (inQuietHours(profile.prefs, now)) {
      result.held++;
      continue;
    }
    const count = sentThisHour.get(key) ?? recentPushCount(ctx, accountId, profileId, now);
    if (count >= PUSH_PER_HOUR) {
      setPushState(ctx.dir, accountId, profileId, item.id, "skipped");
      result.skipped++;
      continue;
    }
    let anyOk = false;
    for (const s of subs) {
      const r = await sendPush(
        s,
        { title: item.title, body: item.body, url: item.url, tag: item.id, ...(item.image ? { icon: `https://image.tmdb.org/t/p/w185${item.image}` } : {}) },
        ctx.push.keys,
        { subject: ctx.push.subject, fetchImpl: ctx.push.fetchImpl, urgency: item.priority === "high" ? "high" : "normal" }
      );
      recordDelivery(ctx.dir, s.id, r, now);
      anyOk ||= r.ok;
    }
    setPushState(ctx.dir, accountId, profileId, item.id, anyOk ? "sent" : "failed");
    if (anyOk) {
      result.sent++;
      sentThisHour.set(key, count + 1);
    }
  }
  return result;
}

function recentPushCount(ctx: JobContext, accountId: string, profileId: string, now: Date): number {
  const inbox = readProfileInbox(ctx.dir, accountId, profileId);
  return inbox.items.filter((n) => n.push === "sent" && now.getTime() - Date.parse(n.createdAt) < 3_600_000).length;
}
