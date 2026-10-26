import { buildStreamVideoId } from "./torrentio";
import { fetchStremioStreams, mergeStremioStreamLists } from "./stremio-streams";
import { getMovieDetails, getMovieExternalIds, getTvExternalIds, searchMovies, searchTv } from "./tmdb";
import type { MediaItem } from "./types";
import { rankStreamsForPlayback, type RankingPreferences } from "./source-ranking";
import type { StremioStream } from "./stremio-streams";

/** A Stremio-compatible source addon the owner enabled (its URL may embed the debrid token). */
export interface SourceAddon {
  name: string;
  url: string;
}

export interface PlayResolveRequest {
  tmdbId?: number;
  type: "movie" | "series";
  season?: number;
  episode?: number;
  title?: string;
  year?: number;
  seriesId?: string;
  /** Enabled release-search addons (server-side only; never sent to browsers). */
  sourceAddons?: SourceAddon[];
  realDebridToken?: string;
  tmdbApiKey?: string;
  /** Rank torrents for browser direct play (H.264 + AAC / MP4). */
  directPlayPreferred?: boolean;
  /** Rank for automatic playback through the media engine (overrides directPlayPreferred). */
  ranking?: RankingPreferences;
}

export async function buildMediaItem(request: PlayResolveRequest): Promise<MediaItem | undefined> {
  const { tmdbId, type, title, year, tmdbApiKey } = request;
  if (!tmdbId) return undefined;

  if (tmdbApiKey && type === "movie") {
    try {
      const movie = await getMovieDetails(tmdbApiKey, tmdbId);
      return {
        id: `tmdb-${tmdbId}`,
        tmdbId,
        title: movie.title,
        overview: movie.overview,
        posterPath: movie.poster_path ?? undefined,
        backdropPath: movie.backdrop_path ?? undefined,
        releaseDate: movie.release_date,
        rating: movie.vote_average,
        originalLanguage: movie.original_language,
        type: "movie",
        source: "debrid",
      };
    } catch {
      /* metadata optional */
    }
  }

  return {
    id: `tmdb-${tmdbId}`,
    tmdbId,
    title: title ?? "Stream",
    releaseDate: year ? String(year) : undefined,
    type,
    source: "debrid",
    season: request.season,
    episode: request.episode,
  };
}

function pickTmdbSearchResult(results: MediaItem[], request: PlayResolveRequest): number | undefined {
  if (results.length === 0) return undefined;
  if (request.year) {
    const withYear = results.find((item) => {
      const y = item.releaseDate ? parseInt(item.releaseDate.slice(0, 4), 10) : undefined;
      return y === request.year;
    });
    if (withYear?.tmdbId) return withYear.tmdbId;
  }
  return results[0]?.tmdbId;
}

/** TMDB id from the request, else a title search. */
export async function resolvePlayTmdbId(request: PlayResolveRequest): Promise<number | undefined> {
  if (request.tmdbId) return request.tmdbId;
  if (!request.tmdbApiKey || !request.title?.trim()) return undefined;
  try {
    const results =
      request.type === "series"
        ? await searchTv(request.tmdbApiKey, request.title)
        : await searchMovies(request.tmdbApiKey, request.title);
    return pickTmdbSearchResult(results, request);
  } catch {
    return undefined;
  }
}

export async function enrichPlayResolveRequest(request: PlayResolveRequest): Promise<PlayResolveRequest> {
  const tmdbId = await resolvePlayTmdbId(request);
  if (!tmdbId || request.tmdbId === tmdbId) return request;
  return { ...request, tmdbId };
}

async function resolveImdbId(request: PlayResolveRequest): Promise<string | undefined> {
  const { tmdbApiKey, tmdbId, type } = request;
  if (!tmdbApiKey || !tmdbId) return undefined;
  try {
    const external = type === "series" ? await getTvExternalIds(tmdbApiKey, tmdbId) : await getMovieExternalIds(tmdbApiKey, tmdbId);
    return external.imdb_id ?? undefined;
  } catch {
    return undefined;
  }
}

/** Addon responses are cached briefly: browsing back to a title should not re-query the addon. */
const STREAM_LIST_TTL_MS = 10 * 60 * 1000;
const streamListCache = new Map<string, { at: number; streams: Promise<StremioStream[]> }>();

function cachedStreams(key: string, load: () => Promise<StremioStream[]>): Promise<StremioStream[]> {
  const hit = streamListCache.get(key);
  if (hit && Date.now() - hit.at < STREAM_LIST_TTL_MS) return hit.streams;
  const streams = load();
  streamListCache.set(key, { at: Date.now(), streams });
  streams.catch(() => streamListCache.delete(key));
  if (streamListCache.size > 300) {
    const oldest = [...streamListCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [k] of oldest) streamListCache.delete(k);
  }
  return streams;
}

/** Queries every enabled source addon in parallel and merges the releases into one ranked list. */
export async function fetchSortedTorrentStreams(request: PlayResolveRequest) {
  const addons = (request.sourceAddons ?? []).filter((a) => a.url);
  if (addons.length === 0) return null;
  const resolved = await enrichPlayResolveRequest(request);
  const imdbId = await resolveImdbId(resolved);
  const videoId = buildStreamVideoId({
    tmdbId: resolved.tmdbId,
    imdbId,
    type: resolved.type,
    season: resolved.season,
    episode: resolved.episode,
  });

  const seen = new Set<string>();
  const results = await Promise.all(
    addons
      .filter((a) => (seen.has(a.url) ? false : (seen.add(a.url), true)))
      .map((addon) =>
        cachedStreams(`${addon.url}|${resolved.type}|${videoId}`, () => fetchStremioStreams(addon.url, resolved.type, videoId))
          .then((streams) => ({ streams, source: addon.name }))
          .catch((err) => {
            console.warn(`[play-resolve] ${addon.name} search failed:`, err instanceof Error ? err.message : err);
            return null;
          })
      )
  );
  const lists = results.filter((r): r is { streams: StremioStream[]; source: string } => r !== null);
  if (lists.length === 0) return null;
  const merged = mergeStremioStreamLists(lists, { directPlayPreferred: Boolean(resolved.directPlayPreferred) });
  if (!resolved.ranking) return merged;

  // Re-order for automatic playback; keep options and playable aligned.
  const order = rankStreamsForPlayback(merged.playable, resolved.ranking);
  return {
    playable: order.map((i) => merged.playable[i]),
    options: order.map((i, rank) => ({ ...merged.options[i], index: rank, recommended: rank === 0 })),
  };
}
