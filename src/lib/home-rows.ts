import type { MediaItem } from "./types";
import { GENRES, HOME_GENRE_SLUGS } from "./genres";

export interface HomeTmdbRowDef {
  id: string;
  title: string;
  catalogType: string;
  page: number;
}

/** Initial TMDB rows loaded with the library on first paint. */
export const HOME_TMDB_ROWS_INITIAL: HomeTmdbRowDef[] = [
  { id: "tmdb-trending-today", title: "Trending Today", catalogType: "trending_day", page: 1 },
  { id: "tmdb-trending-movies", title: "Trending This Week", catalogType: "trending", page: 1 },
  { id: "tmdb-popular-movies", title: "Popular Movies", catalogType: "popular", page: 1 },
  { id: "tmdb-popular-tv", title: "Popular TV Shows", catalogType: "popular_tv", page: 1 },
  { id: "tmdb-now-playing", title: "New in Theaters", catalogType: "now_playing", page: 1 },
  { id: "tmdb-digital", title: "New on Digital", catalogType: "digital", page: 1 },
  { id: "tmdb-trending-tv", title: "Trending TV This Week", catalogType: "trending_tv", page: 1 },
  ...HOME_GENRE_SLUGS.slice(0, 2).map((slug) => genreRowDef(slug)),
];

function genreRowDef(slug: string, page = 1): HomeTmdbRowDef {
  const genre = GENRES.find((g) => g.slug === slug)!;
  return { id: `genre-${slug}${page > 1 ? `-p${page}` : ""}`, title: genre.name, catalogType: `genre:${slug}`, page };
}

/** Additional rows fetched as the user scrolls down the home page. */
export const HOME_TMDB_ROWS_MORE: HomeTmdbRowDef[] = [
  { id: "tmdb-top-rated-movies", title: "Top Rated Movies", catalogType: "top_rated", page: 1 },
  ...HOME_GENRE_SLUGS.slice(2).map((slug) => genreRowDef(slug)),
  { id: "tmdb-airing-today", title: "New Episodes Today", catalogType: "airing_today", page: 1 },
  { id: "tmdb-upcoming", title: "Coming Soon", catalogType: "upcoming", page: 1 },
  { id: "tmdb-on-air", title: "Recently Aired Episodes", catalogType: "on_the_air", page: 1 },
  { id: "tmdb-top-rated-tv", title: "Top Rated TV Shows", catalogType: "top_rated_tv", page: 1 },
  { id: "tmdb-trending-movies-p2", title: "Trending Movies — More", catalogType: "trending", page: 2 },
  { id: "tmdb-trending-tv-p2", title: "Trending TV — More", catalogType: "trending_tv", page: 2 },
  { id: "tmdb-popular-movies-p2", title: "Popular Movies — More", catalogType: "popular", page: 2 },
  { id: "tmdb-popular-tv-p2", title: "Popular TV — More", catalogType: "popular_tv", page: 2 },
  { id: "tmdb-now-playing-p2", title: "In Theaters — More", catalogType: "now_playing", page: 2 },
  { id: "tmdb-digital-p2", title: "More New on Digital", catalogType: "digital", page: 2 },
  { id: "tmdb-trending-movies-p3", title: "Trending Movies — Discover", catalogType: "trending", page: 3 },
  { id: "tmdb-trending-tv-p3", title: "Trending TV — Discover", catalogType: "trending_tv", page: 3 },
  { id: "tmdb-popular-movies-p3", title: "Popular Movies — Discover", catalogType: "popular", page: 3 },
  { id: "tmdb-popular-tv-p3", title: "Popular TV — Discover", catalogType: "popular_tv", page: 3 },
];

export async function fetchHomeTmdbRow(
  def: HomeTmdbRowDef,
  settings: { tmdbConfigured?: boolean }
): Promise<{ id: string; title: string; items: MediaItem[] } | null> {
  if (!settings.tmdbConfigured) return null;

  const query = def.catalogType.startsWith("genre:")
    ? `type=genre&g=${encodeURIComponent(def.catalogType.slice("genre:".length))}&media=all`
    : `type=${encodeURIComponent(def.catalogType)}`;
  const res = await fetch(`/api/catalog?${query}&page=${def.page}`, { credentials: "same-origin" });
  if (!res.ok) return null;

  const data = await res.json();
  if (!data.items?.length) return null;

  return { id: def.id, title: def.title, items: data.items as MediaItem[] };
}
