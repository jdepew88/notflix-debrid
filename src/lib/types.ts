export type MediaSource = "debrid" | "tmdb";

/** TMDB watch-provider API media type (`movie` or `tv`). */
export type TmdbMediaType = "movie" | "tv";

export interface WatchProvider {
  id: number;
  name: string;
  logoPath?: string;
}

export interface WatchProvidersByType {
  flatrate: WatchProvider[];
  rent: WatchProvider[];
  buy: WatchProvider[];
}

export interface MediaItem {
  id: string;
  title: string;
  overview?: string;
  posterPath?: string;
  backdropPath?: string;
  releaseDate?: string;
  runtime?: number;
  rating?: number;
  genres?: string[];
  genreIds?: number[];
  tmdbId?: number;
  /** TMDB media type for watch-provider lookups (`movie` or `tv`). */
  mediaType?: TmdbMediaType;
  /** Original spoken language (ISO 639-1) from TMDB. */
  originalLanguage?: string;
  /** Certification such as "PG-13" or "TV-MA" (US) when known. */
  certification?: string;
  /** TMDB title logo path (PNG), when a localized logo exists. */
  logoPath?: string;
  watchProviders?: WatchProvidersByType;
  type: "movie" | "series" | "episode";
  source: MediaSource;
  streamUrl?: string;
  season?: number;
  episode?: number;
  /** Episode name when `title` holds the series name. */
  episodeTitle?: string;
  seriesId?: string;
  debridId?: string;
  progress?: number;
}

export interface ContentRow {
  id: string;
  title: string;
  items: MediaItem[];
}

export interface UserProfile {
  id: string;
  name: string;
  /** Legacy emoji, `builtin:<avatar id>` or `upload:<file name>` (served by /api/user/avatar). */
  avatar: string;
  isKids?: boolean;
  /** Maturity level (see lib/maturity.ts); unset means "kids" for kids profiles, else "all". */
  maturity?: import("./maturity").MaturityLevel;
  /** scrypt hash of the 4-digit profile PIN. Server-only: stripped before state reaches a browser. */
  pinHash?: string;
  /** Set on profiles sent to the browser instead of `pinHash`. */
  hasPin?: boolean;
  createdAt?: string;
}

export interface DebridDownload {
  id: string;
  filename: string;
  host: string;
  split: number;
  progress: number;
  status: string;
  added: string;
  links: string[];
}

/**
 * Playback settings the browser may see (from /api/settings/sync). Credentials never reach the
 * browser; the *Configured flags say whether the server has them.
 */
export interface AppSettings {
  realDebridConfigured?: boolean;
  tmdbConfigured?: boolean;
  directPlay?: boolean;
  maxResolution?: number;
  playbackQuality?: "best" | "balanced" | "data-saver";
  hardwareAcceleration?: "auto" | "nvenc" | "qsv" | "amf" | "vaapi" | "videotoolbox" | "off";
  audioLanguage?: string;
  subtitleLanguage?: string;
  bufferProfile?: "auto" | "low" | "balanced" | "high";
  maxConcurrentTranscodes?: number;
  surroundAudio?: boolean;
  streamDiagnostics?: boolean;
}

/** True when TMDB metadata is available (key stored on the server). */
export function hasTmdb(settings: Partial<AppSettings>): boolean {
  return Boolean(settings.tmdbConfigured);
}

/** True when Real-Debrid is configured on the server. */
export function hasRealDebrid(settings: Partial<AppSettings>): boolean {
  return Boolean(settings.realDebridConfigured);
}
