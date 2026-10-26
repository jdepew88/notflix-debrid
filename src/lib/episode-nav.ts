import type { SeasonGroup } from "./episode-library";

export function resolveWatchMediaType(
  typeParam: string | null | undefined,
  watchId: string
): "movie" | "series" {
  if (typeParam === "series") return "series";
  if (typeParam === "movie") return "movie";
  if (watchId.startsWith("tmdb-tv-") || watchId.startsWith("series-")) return "series";
  return "movie";
}

export function parseWatchTmdbId(
  watchId: string,
  searchParams: URLSearchParams
): number | undefined {
  const fromQuery = searchParams.get("tmdbId");
  if (fromQuery) {
    const n = parseInt(fromQuery, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  const match = watchId.match(/^tmdb-(?:tv-)?(\d+)$/);
  if (match) return parseInt(match[1], 10);
  return undefined;
}

export function hasSeasonEpisode(
  season?: number,
  episode?: number
): boolean {
  return (
    season != null &&
    episode != null &&
    Number.isFinite(season) &&
    Number.isFinite(episode)
  );
}

export function getNextEpisode(
  seasons: SeasonGroup[],
  season: number,
  episode: number
): { season: number; episode: number } | null {
  const sorted = [...seasons].sort((a, b) => a.season - b.season);
  const group = sorted.find((s) => s.season === season);
  if (!group) return null;

  const nextInSeason = group.episodes.find((e) => e.episode === episode + 1);
  if (nextInSeason) {
    return { season, episode: nextInSeason.episode };
  }

  const nextGroup = sorted.find((s) => s.season > season);
  const first = nextGroup?.episodes[0];
  if (first) {
    return { season: first.season, episode: first.episode };
  }
  return null;
}

export function getPrevEpisode(
  seasons: SeasonGroup[],
  season: number,
  episode: number
): { season: number; episode: number } | null {
  const sorted = [...seasons].sort((a, b) => a.season - b.season);
  const group = sorted.find((s) => s.season === season);
  if (!group) return null;

  const prevInSeason = [...group.episodes]
    .reverse()
    .find((e) => e.episode === episode - 1);
  if (prevInSeason) {
    return { season, episode: prevInSeason.episode };
  }

  const prevGroup = [...sorted].reverse().find((s) => s.season < season);
  const last = prevGroup?.episodes[prevGroup.episodes.length - 1];
  if (last) {
    return { season: last.season, episode: last.episode };
  }
  return null;
}
