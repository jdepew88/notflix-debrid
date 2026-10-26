import type { MediaItem } from "./types";

export function isSeriesItem(item: MediaItem): boolean {
  return (
    item.type === "series" ||
    item.mediaType === "tv" ||
    item.id.startsWith("tmdb-tv-") ||
    item.id.startsWith("series-")
  );
}

export function watchIdForItem(item: MediaItem): string {
  if (item.type === "episode" && item.seriesId) return item.seriesId;
  return item.id;
}

export function watchHrefForItem(item: MediaItem): string {
  const base = `/watch/${encodeURIComponent(watchIdForItem(item))}`;
  const params = new URLSearchParams();

  if (isSeriesItem(item)) {
    params.set("type", "series");
    if (item.tmdbId) params.set("tmdbId", String(item.tmdbId));
    if (item.title) params.set("title", item.title);
  }

  if (item.type === "episode" && item.season != null && item.episode != null) {
    params.set("type", "series");
    params.set("season", String(item.season));
    params.set("episode", String(item.episode));
    if (item.tmdbId) params.set("tmdbId", String(item.tmdbId));
    if (item.title) params.set("title", item.title);
  }

  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function watchHrefForEpisode(opts: {
  watchId: string;
  episodeWatchId?: string;
  tmdbId?: number;
  title?: string;
  season: number;
  episode: number;
}): string {
  const params = new URLSearchParams();
  params.set("type", "series");
  params.set("season", String(opts.season));
  params.set("episode", String(opts.episode));
  if (opts.tmdbId) params.set("tmdbId", String(opts.tmdbId));
  if (opts.title) params.set("title", opts.title);
  const targetId = opts.episodeWatchId ?? opts.watchId;
  return `/watch/${encodeURIComponent(targetId)}?${params.toString()}`;
}
