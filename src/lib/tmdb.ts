import type { MediaItem, TmdbMediaType, WatchProvider, WatchProvidersByType } from "./types";

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE = "https://image.tmdb.org/t/p";

export function posterUrl(path?: string, size: "w185" | "w342" | "w500" | "w780" | "w1280" | "original" = "w500"): string | undefined {
  if (!path) return undefined;
  if (path.startsWith("http") || path.startsWith("/api/")) return path;
  return `${TMDB_IMAGE}/${size}${path}`;
}

export function backdropUrl(path?: string, size: "w780" | "w1280" | "original" = "original"): string | undefined {
  return posterUrl(path, size);
}

/** Landscape card artwork: w780 is plenty for cards up to ~400 px wide at 2× density. */
export function cardBackdropUrl(path?: string): string | undefined {
  return posterUrl(path, "w780");
}

export function providerLogoUrl(path?: string, size: "w45" | "w92" = "w45"): string | undefined {
  if (!path) return undefined;
  return `${TMDB_IMAGE}/${size}${path}`;
}

export function resolveTmdbMediaType(item: MediaItem): TmdbMediaType | null {
  if (item.mediaType) return item.mediaType;
  if (item.type === "movie") return "movie";
  if (item.type === "series") return "tv";
  return null;
}

interface TmdbProvider {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
}

interface TmdbWatchProvidersResponse {
  results: Record<
    string,
    {
      flatrate?: TmdbProvider[];
      rent?: TmdbProvider[];
      buy?: TmdbProvider[];
    }
  >;
}

function mapWatchProviders(list?: TmdbProvider[]): WatchProvider[] {
  if (!list?.length) return [];
  return list.map((p) => ({
    id: p.provider_id,
    name: p.provider_name,
    logoPath: p.logo_path ?? undefined,
  }));
}

export async function getWatchProviders(
  tmdbId: number,
  mediaType: TmdbMediaType,
  apiKey: string,
  country = "US"
): Promise<WatchProvidersByType> {
  const path =
    mediaType === "movie"
      ? `/movie/${tmdbId}/watch/providers`
      : `/tv/${tmdbId}/watch/providers`;
  const data = await tmdbFetch<TmdbWatchProvidersResponse>(path, apiKey);
  const region = data.results[country.toUpperCase()] ?? data.results[country];
  return {
    flatrate: mapWatchProviders(region?.flatrate),
    rent: mapWatchProviders(region?.rent),
    buy: mapWatchProviders(region?.buy),
  };
}

function watchProviderCacheKey(tmdbId: number, mediaType: TmdbMediaType): string {
  return `${mediaType}:${tmdbId}`;
}

export async function enrichItemsWithWatchProviders(
  items: MediaItem[],
  apiKey: string,
  country = "US"
): Promise<MediaItem[]> {
  const targets = new Map<string, { tmdbId: number; mediaType: TmdbMediaType }>();

  for (const item of items) {
    const mediaType = resolveTmdbMediaType(item);
    if (item.tmdbId && mediaType) {
      targets.set(watchProviderCacheKey(item.tmdbId, mediaType), {
        tmdbId: item.tmdbId,
        mediaType,
      });
    }
  }

  if (targets.size === 0) return items;

  const providerCache = new Map<string, WatchProvidersByType>();
  const entries = [...targets.entries()];

  const batchSize = 8;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async ([key, { tmdbId, mediaType }]) => {
        try {
          const providers = await getWatchProviders(tmdbId, mediaType, apiKey, country);
          providerCache.set(key, providers);
        } catch {
          providerCache.set(key, { flatrate: [], rent: [], buy: [] });
        }
      })
    );
  }

  return items.map((item) => {
    const mediaType = resolveTmdbMediaType(item);
    if (!item.tmdbId || !mediaType) return item;
    const providers = providerCache.get(watchProviderCacheKey(item.tmdbId, mediaType));
    if (!providers) return { ...item, mediaType };
    return { ...item, mediaType, watchProviders: providers };
  });
}

/**
 * TMDB accepts a v3 API key (query parameter) or a v4 API Read Access Token (a JWT, sent as a
 * Bearer header so it never appears in URLs or logs).
 */
export function tmdbRequest(path: string, apiKey: string): { url: string; headers: Record<string, string> } {
  const key = apiKey.trim();
  if (key.startsWith("eyJ")) return { url: `${TMDB_BASE}${path}`, headers: { Authorization: `Bearer ${key}` } };
  return { url: `${TMDB_BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(key)}`, headers: {} };
}

async function tmdbFetch<T>(path: string, apiKey: string): Promise<T> {
  const { url, headers } = tmdbRequest(path, apiKey);
  const res = await fetch(url, { headers, next: { revalidate: 3600 } });
  if (!res.ok) throw new Error(`TMDB error: ${res.statusText}`);
  return res.json() as Promise<T>;
}

export interface TmdbCredentialCheck {
  ok: boolean;
  status: "valid" | "invalid" | "unreachable" | "missing";
  message: string;
}

/** Checks a TMDB credential with a lightweight authenticated call. Never echoes the credential. */
export async function validateTmdbCredential(apiKey: string): Promise<TmdbCredentialCheck> {
  const key = apiKey.trim();
  if (!key) return { ok: false, status: "missing", message: "Enter a TMDB API key or read access token." };
  if (!/^[A-Za-z0-9._-]{16,1024}$/.test(key)) {
    return { ok: false, status: "invalid", message: "That doesn't look like a TMDB API key or read access token." };
  }
  try {
    const { url, headers } = tmdbRequest("/configuration", key);
    const res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (res.ok) return { ok: true, status: "valid", message: "TMDB accepted the credential." };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: "invalid", message: "TMDB rejected the credential. Check that you copied the whole key." };
    }
    return { ok: false, status: "unreachable", message: `TMDB answered with HTTP ${res.status}. Try again in a moment.` };
  } catch {
    return { ok: false, status: "unreachable", message: "Could not reach api.themoviedb.org. Check this computer's internet connection." };
  }
}

interface TmdbMovie {
  id: number;
  title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string;
  vote_average: number;
  genre_ids: number[];
  original_language?: string;
}

interface TmdbResponse {
  results: TmdbMovie[];
  total_pages?: number;
}

interface TmdbTv {
  id: number;
  name: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  first_air_date: string;
  vote_average: number;
  genre_ids: number[];
  original_language?: string;
}

interface TmdbTvResponse {
  results: TmdbTv[];
  total_pages?: number;
}

function toMediaItem(movie: TmdbMovie): MediaItem {
  return {
    id: `tmdb-${movie.id}`,
    tmdbId: movie.id,
    mediaType: "movie",
    title: movie.title,
    overview: movie.overview,
    posterPath: movie.poster_path ?? undefined,
    backdropPath: movie.backdrop_path ?? undefined,
    releaseDate: movie.release_date,
    rating: movie.vote_average,
    genreIds: movie.genre_ids,
    originalLanguage: movie.original_language,
    type: "movie",
    source: "tmdb",
  };
}

function toTvMediaItem(show: TmdbTv): MediaItem {
  return {
    id: `tmdb-tv-${show.id}`,
    tmdbId: show.id,
    mediaType: "tv",
    title: show.name,
    overview: show.overview,
    posterPath: show.poster_path ?? undefined,
    backdropPath: show.backdrop_path ?? undefined,
    releaseDate: show.first_air_date,
    rating: show.vote_average,
    genreIds: show.genre_ids,
    originalLanguage: show.original_language,
    type: "series",
    source: "tmdb",
  };
}

export async function getTrending(apiKey: string, page = 1): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbResponse>(`/trending/movie/week?page=${page}`, apiKey);
  return data.results.map(toMediaItem);
}

export async function getTrendingTv(apiKey: string, page = 1): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbTvResponse>(`/trending/tv/week?page=${page}`, apiKey);
  return data.results.map(toTvMediaItem);
}

export async function getPopular(apiKey: string, page = 1): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbResponse>(`/movie/popular?page=${page}`, apiKey);
  return data.results.map(toMediaItem);
}

export async function getPopularTv(apiKey: string, page = 1): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbTvResponse>(`/tv/popular?page=${page}`, apiKey);
  return data.results.map(toTvMediaItem);
}

export async function getTopRated(apiKey: string, page = 1): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbResponse>(`/movie/top_rated?page=${page}`, apiKey);
  return data.results.map(toMediaItem);
}

export async function getTopRatedTv(apiKey: string, page = 1): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbTvResponse>(`/tv/top_rated?page=${page}`, apiKey);
  return data.results.map(toTvMediaItem);
}

export async function getNowPlaying(apiKey: string, page = 1): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbResponse>(`/movie/now_playing?page=${page}`, apiKey);
  return data.results.map(toMediaItem);
}

export async function getOnTheAir(apiKey: string, page = 1): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbTvResponse>(`/tv/on_the_air?page=${page}`, apiKey);
  return data.results.map(toTvMediaItem);
}

export async function getAiringToday(apiKey: string, page = 1): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbTvResponse>(`/tv/airing_today?page=${page}`, apiKey);
  return data.results.map(toTvMediaItem);
}

/** Movies and shows trending today (mixed list). */
export async function getTrendingToday(apiKey: string, page = 1): Promise<MediaItem[]> {
  const data = await tmdbFetch<{ results: Array<(TmdbMovie & TmdbTv) & { media_type?: string }> }>(
    `/trending/all/day?page=${page}`,
    apiKey
  );
  return data.results
    .filter((r) => r.media_type === "movie" || r.media_type === "tv")
    .map((r) => (r.media_type === "tv" ? toTvMediaItem(r) : toMediaItem(r)));
}

export async function getUpcoming(apiKey: string, page = 1, region = "US"): Promise<MediaItem[]> {
  const today = new Date().toISOString().slice(0, 10);
  const data = await tmdbFetch<TmdbResponse>(
    `/discover/movie?page=${page}&region=${region}&with_release_type=2|3&primary_release_date.gte=${today}&sort_by=popularity.desc`,
    apiKey
  );
  return data.results.map(toMediaItem);
}

/** Recent digital (streaming/rental) releases from the last ~75 days. */
export async function getDigitalReleases(apiKey: string, page = 1, region = "US"): Promise<MediaItem[]> {
  const today = new Date();
  const from = new Date(today.getTime() - 75 * 86_400_000).toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);
  const data = await tmdbFetch<TmdbResponse>(
    `/discover/movie?page=${page}&region=${region}&with_release_type=4&release_date.gte=${from}&release_date.lte=${to}&sort_by=popularity.desc&vote_count.gte=20`,
    apiKey
  );
  return data.results.map(toMediaItem);
}

export async function getRecommendations(apiKey: string, id: number, media: "movie" | "tv"): Promise<MediaItem[]> {
  if (media === "tv") {
    const data = await tmdbFetch<TmdbTvResponse>(`/tv/${id}/recommendations`, apiKey);
    return data.results.map(toTvMediaItem);
  }
  const data = await tmdbFetch<TmdbResponse>(`/movie/${id}/recommendations`, apiKey);
  return data.results.map(toMediaItem);
}

export async function searchMovies(apiKey: string, query: string): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbResponse>(
    `/search/movie?query=${encodeURIComponent(query)}`,
    apiKey
  );
  return data.results.map(toMediaItem);
}

export async function searchTv(apiKey: string, query: string): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbTvResponse>(
    `/search/tv?query=${encodeURIComponent(query)}`,
    apiKey
  );
  return data.results.map(toTvMediaItem);
}

export async function getMovieDetails(apiKey: string, id: number) {
  return tmdbFetch<
    TmdbMovie & {
      runtime: number;
      genres: Array<{ id: number; name: string }>;
      spoken_languages: Array<{ english_name: string }>;
      original_language?: string;
    }
  >(`/movie/${id}`, apiKey);
}

export interface HeroDetails {
  tmdbId: number;
  media: "movie" | "tv";
  title: string;
  overview: string;
  backdropPath?: string;
  posterPath?: string;
  /** English (or language-neutral) title logo, when TMDB has one. */
  logoPath?: string;
  year?: string;
  certification?: string;
  runtime?: number;
  genres: string[];
  rating?: number;
  originalLanguage?: string;
  /** YouTube trailer/teaser key, only when an official video exists. */
  trailerKey: string | null;
}

/**
 * Everything the cinematic hero needs in one TMDB request (details + images + videos + ratings).
 * Logos prefer English, then language-neutral; only official YouTube trailers/teasers are used.
 */
export async function getHeroDetails(apiKey: string, id: number, media: "movie" | "tv", region = "US"): Promise<HeroDetails> {
  type Img = { file_path: string; iso_639_1: string | null; vote_average: number; width: number };
  type Vid = { key: string; site: string; type: string; official?: boolean; iso_639_1?: string };
  if (media === "tv") {
    const d = await tmdbFetch<{
      id: number; name: string; overview: string; backdrop_path: string | null; poster_path: string | null; first_air_date: string;
      vote_average: number; episode_run_time?: number[]; genres: Array<{ name: string }>; original_language?: string;
      images?: { logos?: Img[] }; videos?: { results: Vid[] };
      content_ratings?: { results: Array<{ iso_3166_1: string; rating: string }> };
    }>(`/tv/${id}?append_to_response=images,videos,content_ratings&include_image_language=en,null`, apiKey);
    return {
      tmdbId: d.id, media, title: d.name, overview: d.overview,
      backdropPath: d.backdrop_path ?? undefined, posterPath: d.poster_path ?? undefined,
      logoPath: pickLogo(d.images?.logos), year: d.first_air_date?.slice(0, 4) || undefined,
      certification: d.content_ratings?.results.find((r) => r.iso_3166_1 === region)?.rating || undefined,
      runtime: d.episode_run_time?.[0], genres: d.genres.map((g) => g.name), rating: d.vote_average,
      originalLanguage: d.original_language, trailerKey: pickTrailer(d.videos?.results),
    };
  }
  const d = await tmdbFetch<{
    id: number; title: string; overview: string; backdrop_path: string | null; poster_path: string | null; release_date: string;
    vote_average: number; runtime?: number; genres: Array<{ name: string }>; original_language?: string;
    images?: { logos?: Img[] }; videos?: { results: Vid[] };
    release_dates?: { results: Array<{ iso_3166_1: string; release_dates: Array<{ certification: string }> }> };
  }>(`/movie/${id}?append_to_response=images,videos,release_dates&include_image_language=en,null`, apiKey);
  const cert = d.release_dates?.results.find((r) => r.iso_3166_1 === region)?.release_dates.find((r) => r.certification)?.certification;
  return {
    tmdbId: d.id, media, title: d.title, overview: d.overview,
    backdropPath: d.backdrop_path ?? undefined, posterPath: d.poster_path ?? undefined,
    logoPath: pickLogo(d.images?.logos), year: d.release_date?.slice(0, 4) || undefined,
    certification: cert || undefined, runtime: d.runtime, genres: d.genres.map((g) => g.name), rating: d.vote_average,
    originalLanguage: d.original_language, trailerKey: pickTrailer(d.videos?.results),
  };

}

type TmdbImage = { file_path: string; iso_639_1: string | null; vote_average: number; width: number };
type TmdbVideo = { key: string; site: string; type: string; official?: boolean; iso_639_1?: string };

function pickLogo(logos?: TmdbImage[]): string | undefined {
  if (!logos?.length) return undefined;
  const png = logos.filter((l) => l.file_path.endsWith(".png") || l.file_path.endsWith(".svg"));
  const pool = png.length ? png : logos;
  const en = pool.filter((l) => l.iso_639_1 === "en");
  const neutral = pool.filter((l) => !l.iso_639_1);
  const best = [...en, ...neutral].sort((a, b) => b.vote_average - a.vote_average || b.width - a.width)[0];
  return best?.file_path;
}
function pickTrailer(videos?: TmdbVideo[]): string | null {
  if (!videos?.length) return null;
  const yt = videos.filter((v) => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser"));
  const ranked = yt.sort((a, b) => Number(b.official ?? false) - Number(a.official ?? false) || (a.type === "Trailer" ? -1 : 1));
  return ranked[0]?.key ?? null;
}


/** TMDB image URL for a title logo (PNG with transparency). */
export function logoUrl(path?: string, size: "w300" | "w500" | "original" = "w500"): string | null {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

export async function getMovieExternalIds(
  apiKey: string,
  id: number
): Promise<{ imdb_id: string | null }> {
  return tmdbFetch<{ imdb_id: string | null }>(`/movie/${id}/external_ids`, apiKey);
}

export async function getTvExternalIds(
  apiKey: string,
  id: number
): Promise<{ imdb_id: string | null }> {
  return tmdbFetch<{ imdb_id: string | null }>(`/tv/${id}/external_ids`, apiKey);
}

export async function getTvDetails(apiKey: string, id: number) {
  return tmdbFetch<{
    id: number;
    name: string;
    overview: string;
    poster_path: string | null;
    backdrop_path: string | null;
    first_air_date: string;
    vote_average: number;
    number_of_seasons: number;
    seasons: Array<{
      season_number: number;
      episode_count: number;
      name: string;
      poster_path: string | null;
    }>;
    genres: Array<{ id: number; name: string }>;
  }>(`/tv/${id}`, apiKey);
}

export async function getTvSeasonEpisodes(apiKey: string, tvId: number, season: number) {
  return tmdbFetch<{
    episodes: Array<{
      season_number: number;
      episode_number: number;
      name: string;
      overview: string;
      still_path: string | null;
      air_date: string;
      runtime: number | null;
    }>;
  }>(`/tv/${tvId}/season/${season}`, apiKey);
}

export function tmdbSeasonsToGroups(
  seasons: Array<{
    season_number: number;
    episode_count: number;
    name: string;
    poster_path: string | null;
  }>
): Array<{ season: number; episodeCount: number; name: string; posterPath?: string }> {
  return seasons
    .filter((s) => s.season_number > 0)
    .map((s) => ({
      season: s.season_number,
      episodeCount: s.episode_count,
      name: s.name,
      posterPath: s.poster_path ?? undefined,
    }));
}

export async function getMovieVideos(apiKey: string, id: number): Promise<string | null> {
  const data = await tmdbFetch<{
    results: Array<{ key: string; site: string; type: string }>;
  }>(`/movie/${id}/videos`, apiKey);
  const trailer = data.results.find(
    (v) => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser")
  );
  return trailer?.key ?? null;
}

export async function getSimilarMovies(apiKey: string, id: number): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbResponse>(`/movie/${id}/similar`, apiKey);
  return data.results.map(toMediaItem);
}

export async function getTvVideos(apiKey: string, id: number): Promise<string | null> {
  const data = await tmdbFetch<{
    results: Array<{ key: string; site: string; type: string }>;
  }>(`/tv/${id}/videos`, apiKey);
  const trailer = data.results.find(
    (v) => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser")
  );
  return trailer?.key ?? null;
}

export async function getSimilarTv(apiKey: string, id: number): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbTvResponse>(`/tv/${id}/similar`, apiKey);
  return data.results.map(toTvMediaItem);
}

export async function getGenres(apiKey: string): Promise<Array<{ id: number; name: string }>> {
  const data = await tmdbFetch<{ genres: Array<{ id: number; name: string }> }>(
    "/genre/movie/list",
    apiKey
  );
  return data.genres;
}

/**
 * Genre discovery for films or television. English-language metadata, US region, adult content
 * excluded; the sort guards (vote counts) live in genres.ts so the UI and server agree.
 */
export async function discoverByGenre(
  apiKey: string,
  media: "movie" | "tv",
  genreId: number,
  page = 1,
  sort: import("./genres").GenreSort = "popularity",
  region = "US"
): Promise<{ items: MediaItem[]; totalPages: number; totalResults: number }> {
  const { tmdbSortParams } = await import("./genres");
  const common = `with_genres=${genreId}&page=${page}&${tmdbSortParams(sort, media)}&include_adult=false&language=en-US`;
  if (media === "tv") {
    const data = await tmdbFetch<TmdbTvResponse & { total_pages: number; total_results: number }>(
      `/discover/tv?${common}&include_null_first_air_dates=false&watch_region=${region}`,
      apiKey
    );
    return { items: data.results.map(toTvMediaItem), totalPages: Math.min(data.total_pages, 500), totalResults: data.total_results };
  }
  const data = await tmdbFetch<TmdbResponse & { total_pages: number; total_results: number }>(
    `/discover/movie?${common}&region=${region}`,
    apiKey
  );
  return { items: data.results.map(toMediaItem), totalPages: Math.min(data.total_pages, 500), totalResults: data.total_results };
}

export async function getMoviesByGenre(
  apiKey: string,
  genreId: number,
  page = 1
): Promise<{ items: MediaItem[]; totalPages: number }> {
  const data = await tmdbFetch<TmdbResponse & { total_pages: number }>(
    `/discover/movie?with_genres=${genreId}&page=${page}&sort_by=popularity.desc`,
    apiKey
  );
  return { items: data.results.map(toMediaItem), totalPages: data.total_pages };
}

export async function discoverMoviesByProvider(
  apiKey: string,
  providerId: number,
  page = 1,
  country = "US"
): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbResponse>(
    `/discover/movie?with_watch_providers=${providerId}&watch_region=${country}&sort_by=popularity.desc&page=${page}`,
    apiKey
  );
  return data.results.map(toMediaItem);
}

export async function discoverTvByProvider(
  apiKey: string,
  providerId: number,
  page = 1,
  country = "US"
): Promise<MediaItem[]> {
  const data = await tmdbFetch<TmdbTvResponse>(
    `/discover/tv?with_watch_providers=${providerId}&watch_region=${country}&sort_by=popularity.desc&page=${page}`,
    apiKey
  );
  return data.results.map(toTvMediaItem);
}

async function enrichSeriesWithTmdb(
  item: MediaItem,
  apiKey: string
): Promise<MediaItem> {
  let tmdbId = item.tmdbId;
  if (!tmdbId) {
    const results = await searchTv(apiKey, item.title);
    tmdbId = results[0]?.tmdbId;
  }
  if (!tmdbId) return item;

  const details = await getTvDetails(apiKey, tmdbId);
  return {
    ...item,
    tmdbId,
    mediaType: "tv",
    title: details.name || item.title,
    overview: item.overview || details.overview,
    posterPath: item.posterPath || posterUrl(details.poster_path ?? undefined),
    backdropPath: item.backdropPath || backdropUrl(details.backdrop_path ?? undefined),
    releaseDate: item.releaseDate || details.first_air_date,
    rating: item.rating ?? details.vote_average,
    genres:
      item.genres?.length ? item.genres : details.genres.map((g) => g.name),
  };
}

async function enrichMovieWithTmdb(
  item: MediaItem,
  apiKey: string
): Promise<MediaItem> {
  let tmdbId = item.tmdbId;
  if (!tmdbId) {
    const results = await searchMovies(apiKey, item.title);
    tmdbId = results[0]?.tmdbId;
  }
  if (!tmdbId) return item;

  const details = await getMovieDetails(apiKey, tmdbId);
  return {
    ...item,
    tmdbId,
    mediaType: "movie",
    title: details.title || item.title,
    overview: item.overview || details.overview,
    posterPath: item.posterPath || posterUrl(details.poster_path ?? undefined),
    backdropPath: item.backdropPath || backdropUrl(details.backdrop_path ?? undefined),
    releaseDate: item.releaseDate || details.release_date,
    rating: item.rating ?? details.vote_average,
    runtime: item.runtime ?? details.runtime,
    genres:
      item.genres?.length
        ? item.genres
        : details.genres.map((g) => g.name),
  };
}

export async function enrichLibraryWithTmdb(
  items: MediaItem[],
  apiKey: string
): Promise<MediaItem[]> {
  const targets = items.filter((item) => item.type === "series" || item.type === "movie");
  const enrichedById = new Map<string, MediaItem>();
  const batchSize = 8;

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (item) => {
        try {
          const enriched =
            item.type === "series"
              ? await enrichSeriesWithTmdb(item, apiKey)
              : await enrichMovieWithTmdb(item, apiKey);
          enrichedById.set(item.id, enriched);
        } catch {
          /* keep original */
        }
      })
    );
  }

  return items.map((item) => enrichedById.get(item.id) ?? item);
}

export async function applyTmdbMetadataToItem(
  item: MediaItem,
  apiKey: string,
  options: {
    tmdbId?: number;
    mediaType?: TmdbMediaType;
    forceArtwork?: boolean;
    query?: string;
  } = {}
): Promise<MediaItem> {
  const isSeries = item.type === "series" || options.mediaType === "tv";
  let tmdbId = options.tmdbId ?? item.tmdbId;
  let mediaType: TmdbMediaType = options.mediaType ?? (isSeries ? "tv" : "movie");

  if (!tmdbId) {
    const query = options.query?.trim() || item.title;
    const results = isSeries ? await searchTv(apiKey, query) : await searchMovies(apiKey, query);
    const pick = results[0];
    if (!pick?.tmdbId) return item;
    tmdbId = pick.tmdbId;
    mediaType = pick.mediaType ?? mediaType;
  }

  if (mediaType === "tv" || item.type === "series") {
    const details = await getTvDetails(apiKey, tmdbId);
    return {
      ...item,
      tmdbId,
      mediaType: "tv",
      title: details.name || item.title,
      overview: details.overview || item.overview,
      posterPath: options.forceArtwork
        ? posterUrl(details.poster_path ?? undefined)
        : item.posterPath || posterUrl(details.poster_path ?? undefined),
      backdropPath: options.forceArtwork
        ? backdropUrl(details.backdrop_path ?? undefined)
        : item.backdropPath || backdropUrl(details.backdrop_path ?? undefined),
      releaseDate: details.first_air_date || item.releaseDate,
      rating: details.vote_average ?? item.rating,
      genres: details.genres.map((g) => g.name),
      genreIds: details.genres.map((g) => g.id),
    };
  }

  const details = await getMovieDetails(apiKey, tmdbId);
  return {
    ...item,
    tmdbId,
    mediaType: "movie",
    title: details.title || item.title,
    overview: details.overview || item.overview,
    posterPath: options.forceArtwork
      ? posterUrl(details.poster_path ?? undefined)
      : item.posterPath || posterUrl(details.poster_path ?? undefined),
    backdropPath: options.forceArtwork
      ? backdropUrl(details.backdrop_path ?? undefined)
      : item.backdropPath || backdropUrl(details.backdrop_path ?? undefined),
    releaseDate: details.release_date || item.releaseDate,
    rating: details.vote_average ?? item.rating,
    runtime: details.runtime ?? item.runtime,
    genres: details.genres.map((g) => g.name),
    genreIds: details.genres.map((g) => g.id),
  };
}

export async function searchTmdbForMatch(
  apiKey: string,
  query: string,
  mediaType?: TmdbMediaType
): Promise<MediaItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  if (mediaType === "tv") return searchTv(apiKey, trimmed);
  if (mediaType === "movie") return searchMovies(apiKey, trimmed);

  const [movies, shows] = await Promise.all([
    searchMovies(apiKey, trimmed),
    searchTv(apiKey, trimmed),
  ]);
  return [...movies, ...shows].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
}

export interface TitlePerson {
  name: string;
  role?: string;
  profilePath?: string;
}

export interface TitleSeason {
  season: number;
  name: string;
  episodeCount: number;
  airDate?: string;
  posterPath?: string;
}

export interface TitleDetails {
  item: MediaItem;
  tagline?: string;
  year?: string;
  logoPath?: string;
  trailerKey: string | null;
  directors: TitlePerson[];
  creators: TitlePerson[];
  cast: TitlePerson[];
  seasons: TitleSeason[];
  numberOfSeasons?: number;
  numberOfEpisodes?: number;
  status?: string;
  recommendations: MediaItem[];
}

/**
 * Everything the title details view needs in one TMDB request: details, credits, videos, logos,
 * US rating and recommendations (falls back to "similar" when TMDB has no recommendations).
 */
export async function getTitleDetails(apiKey: string, id: number, media: "movie" | "tv", region = "US"): Promise<TitleDetails> {
  type Credits = {
    cast?: Array<{ name: string; character?: string; profile_path: string | null; order?: number }>;
    crew?: Array<{ name: string; job?: string; profile_path: string | null }>;
  };
  const append = `credits,videos,images,recommendations,similar,${media === "tv" ? "content_ratings" : "release_dates"}`;
  const d = await tmdbFetch<{
    id: number;
    title?: string;
    name?: string;
    overview: string;
    tagline?: string;
    backdrop_path: string | null;
    poster_path: string | null;
    release_date?: string;
    first_air_date?: string;
    vote_average: number;
    runtime?: number;
    episode_run_time?: number[];
    genres: Array<{ id: number; name: string }>;
    original_language?: string;
    status?: string;
    number_of_seasons?: number;
    number_of_episodes?: number;
    created_by?: Array<{ name: string; profile_path: string | null }>;
    seasons?: Array<{ season_number: number; name: string; episode_count: number; air_date: string | null; poster_path: string | null }>;
    credits?: Credits;
    images?: { logos?: TmdbImage[] };
    videos?: { results: TmdbVideo[] };
    recommendations?: { results: Array<TmdbMovie & TmdbTv> };
    similar?: { results: Array<TmdbMovie & TmdbTv> };
    release_dates?: { results: Array<{ iso_3166_1: string; release_dates: Array<{ certification: string; type: number }> }> };
    content_ratings?: { results: Array<{ iso_3166_1: string; rating: string }> };
  }>(`/${media}/${id}?append_to_response=${append}&include_image_language=en,null`, apiKey);

  const certification =
    media === "tv"
      ? d.content_ratings?.results.find((r) => r.iso_3166_1 === region)?.rating
      : d.release_dates?.results
          .find((r) => r.iso_3166_1 === region)
          ?.release_dates.slice()
          .sort((a, b) => Number(b.type === 3 || b.type === 2) - Number(a.type === 3 || a.type === 2))
          .find((r) => r.certification?.trim())?.certification;
  const date = media === "tv" ? d.first_air_date : d.release_date;
  const item: MediaItem = {
    id: media === "tv" ? `tmdb-tv-${d.id}` : `tmdb-${d.id}`,
    tmdbId: d.id,
    mediaType: media,
    title: (media === "tv" ? d.name : d.title) ?? "",
    overview: d.overview,
    posterPath: d.poster_path ?? undefined,
    backdropPath: d.backdrop_path ?? undefined,
    releaseDate: date,
    rating: d.vote_average,
    runtime: media === "tv" ? d.episode_run_time?.[0] : d.runtime,
    genres: d.genres.map((g) => g.name),
    genreIds: d.genres.map((g) => g.id),
    originalLanguage: d.original_language,
    certification: certification?.trim() || undefined,
    logoPath: pickLogo(d.images?.logos),
    type: media === "tv" ? "series" : "movie",
    source: "tmdb",
  };
  const person = (p: { name: string; profile_path: string | null }, role?: string): TitlePerson => ({
    name: p.name,
    role,
    profilePath: p.profile_path ?? undefined,
  });
  const recs = d.recommendations?.results?.length ? d.recommendations.results : d.similar?.results ?? [];
  const toItem = media === "tv" ? toTvMediaItem : toMediaItem;
  return {
    item,
    tagline: d.tagline || undefined,
    year: date?.slice(0, 4) || undefined,
    logoPath: item.logoPath,
    trailerKey: pickTrailer(d.videos?.results),
    directors: (d.credits?.crew ?? []).filter((c) => c.job === "Director").slice(0, 3).map((c) => person(c, "Director")),
    creators: (d.created_by ?? []).slice(0, 3).map((c) => person(c, "Creator")),
    cast: (d.credits?.cast ?? []).slice(0, 12).map((c) => person(c, c.character || undefined)),
    seasons: (d.seasons ?? [])
      .filter((s) => s.season_number > 0 && s.episode_count > 0)
      .map((s) => ({ season: s.season_number, name: s.name, episodeCount: s.episode_count, airDate: s.air_date ?? undefined, posterPath: s.poster_path ?? undefined })),
    numberOfSeasons: d.number_of_seasons,
    numberOfEpisodes: d.number_of_episodes,
    status: d.status,
    recommendations: recs.slice(0, 18).map((r) => toItem(r)).filter((r) => r.posterPath),
  };
}

export interface SeasonEpisode {
  season: number;
  episode: number;
  name: string;
  overview: string;
  stillPath?: string;
  airDate?: string;
  runtime?: number;
  rating?: number;
}

export async function getSeasonDetails(apiKey: string, tvId: number, season: number): Promise<{ season: number; name: string; overview: string; episodes: SeasonEpisode[] }> {
  const d = await tmdbFetch<{
    season_number: number;
    name: string;
    overview: string;
    episodes: Array<{ season_number: number; episode_number: number; name: string; overview: string; still_path: string | null; air_date: string | null; runtime: number | null; vote_average?: number }>;
  }>(`/tv/${tvId}/season/${season}`, apiKey);
  return {
    season: d.season_number,
    name: d.name,
    overview: d.overview,
    episodes: d.episodes.map((e) => ({
      season: e.season_number,
      episode: e.episode_number,
      name: e.name,
      overview: e.overview,
      stillPath: e.still_path ?? undefined,
      airDate: e.air_date ?? undefined,
      runtime: e.runtime ?? undefined,
      rating: e.vote_average || undefined,
    })),
  };
}

/** Card-level data for one title (used to show saved My List titles that are not in any loaded row). */
export async function getBasicTitle(apiKey: string, id: number, media: "movie" | "tv"): Promise<MediaItem> {
  if (media === "tv") {
    const d = await tmdbFetch<TmdbTv & { genres?: Array<{ id: number; name: string }> }>(`/tv/${id}`, apiKey);
    return { ...toTvMediaItem({ ...d, genre_ids: d.genres?.map((g) => g.id) ?? [] }), genres: d.genres?.map((g) => g.name) };
  }
  const d = await tmdbFetch<TmdbMovie & { genres?: Array<{ id: number; name: string }>; runtime?: number }>(`/movie/${id}`, apiKey);
  return { ...toMediaItem({ ...d, genre_ids: d.genres?.map((g) => g.id) ?? [] }), genres: d.genres?.map((g) => g.name), runtime: d.runtime };
}
