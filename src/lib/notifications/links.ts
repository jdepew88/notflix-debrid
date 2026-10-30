import type { MediaItem } from "../types";

/** In-app paths only: "/x", never "//host" or absolute URLs (notification text is data, not code). */
export function safeAppPath(url: unknown): string {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.includes("\\") ? url : "/browse";
}

/**
 * A title link ("/browse?title=tmdb-tv-123&season=2", as notifications and push messages use) as
 * the minimal item the details dialog needs; null for any other link.
 */
export function titleFromLink(url: string, name?: string): (MediaItem & { season?: number }) | null {
  let u: URL;
  try {
    u = new URL(url, "http://notflix.local");
  } catch {
    return null;
  }
  if (u.pathname !== "/browse") return null;
  const id = u.searchParams.get("title") ?? "";
  const tv = /^tmdb-tv-(\d{1,9})$/.exec(id);
  const movie = /^tmdb-(\d{1,9})$/.exec(id);
  if (!tv && !movie) return null;
  const season = Number(u.searchParams.get("season"));
  return {
    id,
    tmdbId: Number((tv ?? movie)![1]),
    mediaType: tv ? "tv" : "movie",
    type: tv ? "series" : "movie",
    source: "tmdb",
    title: name ?? "",
    ...(Number.isInteger(season) && season > 0 ? { season } : {}),
  };
}
