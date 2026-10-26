import type { MediaItem } from "./types";
import { getResumeForItem } from "./store";
import { watchHrefForEpisode, watchHrefForItem, watchIdForItem } from "./watch-url";

export function canPlayItem(item: MediaItem): boolean {
  return (
    item.source === "debrid" ||
    item.source === "tmdb" ||
    !!item.streamUrl ||
    !!item.tmdbId ||
    item.id.startsWith("debrid-") ||
    item.id.startsWith("tmdb-")
  );
}

export function watchHref(item: MediaItem): string {
  return playHrefForItem(item);
}

export function playHrefForItem(item: MediaItem): string {
  const resume = getResumeForItem(item);
  if (resume) return resume.href;

  if (item.season != null && item.episode != null) {
    return watchHrefForEpisode({
      watchId: watchIdForItem(item),
      tmdbId: item.tmdbId,
      title: item.title,
      season: item.season,
      episode: item.episode,
    });
  }

  return watchHrefForItem(item);
}

export function playLabelForItem(item: MediaItem): string {
  const resume = getResumeForItem(item);
  return resume?.label ?? "Play";
}
