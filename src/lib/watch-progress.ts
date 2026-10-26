import type { MediaItem } from "./types";
import { formatEpisodeLabel } from "./episode-parse";
import { isSeriesItem, watchHrefForEpisode, watchHrefForItem, watchIdForItem } from "./watch-url";

/** Minimal card metadata so Continue Watching works for titles that are not in a library. */
export interface WatchedItemMeta {
  id: string;
  title: string;
  type: "movie" | "series" | "episode";
  tmdbId?: number;
  mediaType?: "movie" | "tv";
  posterPath?: string;
  backdropPath?: string;
  releaseDate?: string;
}

export interface LastWatchedEntry {
  season?: number;
  episode?: number;
  progress: number;
  updatedAt: number;
  item?: WatchedItemMeta;
  /** Absolute resume position (seconds) — lets playback start right there instead of seeking. */
  positionSeconds?: number;
  durationSeconds?: number;
}

export function episodeProgressKey(
  seriesId: string,
  season: number,
  episode: number
): string {
  return `${seriesId}:S${season}E${episode}`;
}

export function parseEpisodeProgressKey(
  key: string
): { seriesId: string; season: number; episode: number } | null {
  const match = key.match(/^(.+):S(\d+)E(\d+)$/);
  if (!match) return null;
  return {
    seriesId: match[1],
    season: parseInt(match[2], 10),
    episode: parseInt(match[3], 10),
  };
}

export function resolveProgressKey(opts: {
  watchId: string;
  season?: number;
  episode?: number;
}): string {
  if (opts.season != null && opts.episode != null) {
    return episodeProgressKey(opts.watchId, opts.season, opts.episode);
  }
  return opts.watchId;
}

export interface ResumePlayback {
  href: string;
  label: string;
  progress: number;
  season?: number;
  episode?: number;
}

export function getResumePlayback(
  item: MediaItem,
  progressMap: Record<string, number>,
  lastWatched?: LastWatchedEntry | null
): ResumePlayback | null {
  const watchId = watchIdForItem(item);
  const entry: LastWatchedEntry | null =
    lastWatched ??
    (() => {
      const direct = progressMap[watchId];
      if (direct && direct > 0 && direct < 95) {
        return { progress: direct, updatedAt: 0 } satisfies LastWatchedEntry;
      }
      return null;
    })();

  if (!entry || entry.progress <= 0 || entry.progress >= 95) return null;

  if (isSeriesItem(item)) {
    if (entry.season != null && entry.episode != null) {
      const epKey = episodeProgressKey(watchId, entry.season, entry.episode);
      const progress = progressMap[epKey] ?? entry.progress;
      if (progress <= 0 || progress >= 95) return null;
      return {
        href: watchHrefForEpisode({
          watchId,
          tmdbId: item.tmdbId,
          title: item.title,
          season: entry.season,
          episode: entry.episode,
        }),
        label: `Resume ${formatEpisodeLabel(entry.season, entry.episode)}`,
        progress,
        season: entry.season,
        episode: entry.episode,
      };
    }
    return null;
  }

  const progress = progressMap[watchId] ?? entry.progress;
  if (progress <= 0 || progress >= 95) return null;

  return {
    href: watchHrefForItem(item),
    label: "Resume",
    progress,
  };
}

export function formatMatchScore(rating?: number): string | null {
  if (!rating || rating <= 0) return null;
  return `${Math.min(99, Math.round(rating * 10))}% Match`;
}
