/**
 * Genre catalog shared by the navbar, genre pages and homepage rows.
 *
 * TMDB uses different identifiers for films and television (e.g. film "Action" is 28, TV has
 * "Action & Adventure" 10759; "Science Fiction" 878 vs "Sci-Fi & Fantasy" 10765), so each genre maps
 * to both. A null id means TMDB has no TV genre for it; those genres show films only.
 */
export interface GenreDef {
  slug: string;
  name: string;
  movieId: number | null;
  tvId: number | null;
}

export const GENRES: GenreDef[] = [
  { slug: "action", name: "Action", movieId: 28, tvId: 10759 },
  { slug: "adventure", name: "Adventure", movieId: 12, tvId: 10759 },
  { slug: "animation", name: "Animation", movieId: 16, tvId: 16 },
  { slug: "comedy", name: "Comedy", movieId: 35, tvId: 35 },
  { slug: "crime", name: "Crime", movieId: 80, tvId: 80 },
  { slug: "documentary", name: "Documentary", movieId: 99, tvId: 99 },
  { slug: "drama", name: "Drama", movieId: 18, tvId: 18 },
  { slug: "family", name: "Family", movieId: 10751, tvId: 10751 },
  { slug: "fantasy", name: "Fantasy", movieId: 14, tvId: 10765 },
  { slug: "history", name: "History", movieId: 36, tvId: null },
  { slug: "horror", name: "Horror", movieId: 27, tvId: null },
  { slug: "music", name: "Music", movieId: 10402, tvId: null },
  { slug: "mystery", name: "Mystery", movieId: 9648, tvId: 9648 },
  { slug: "romance", name: "Romance", movieId: 10749, tvId: null },
  { slug: "science-fiction", name: "Science Fiction", movieId: 878, tvId: 10765 },
  { slug: "thriller", name: "Thriller", movieId: 53, tvId: null },
  { slug: "war", name: "War", movieId: 10752, tvId: 10768 },
  { slug: "western", name: "Western", movieId: 37, tvId: 37 },
];

/** Genres shown in the navbar Browse menu. */
export const NAV_GENRE_SLUGS = [
  "action", "adventure", "animation", "comedy", "crime", "documentary", "drama",
  "fantasy", "horror", "romance", "science-fiction", "thriller",
];

/** Genre rows on the homepage (in order). */
export const HOME_GENRE_SLUGS = ["action", "comedy", "science-fiction", "horror", "thriller", "animation"];

const LEGACY_NAMES: Record<string, string> = {
  "sci-fi": "science-fiction",
  scifi: "science-fiction",
  "science fiction": "science-fiction",
  "sci-fi & fantasy": "science-fiction",
  "action & adventure": "action",
  "war & politics": "war",
};

export function findGenre(slugOrName: string | null | undefined): GenreDef | undefined {
  if (!slugOrName) return undefined;
  const key = slugOrName.trim().toLowerCase();
  const slug = LEGACY_NAMES[key] ?? key.replace(/\s+/g, "-");
  return GENRES.find((g) => g.slug === slug || g.name.toLowerCase() === key);
}

/** Genre for a TMDB genre id (movie or TV), e.g. when a card only has genreIds. */
export function genreForTmdbId(id: number, media: "movie" | "tv"): GenreDef | undefined {
  return GENRES.find((g) => (media === "tv" ? g.tvId : g.movieId) === id);
}

export type GenreSort = "popularity" | "release" | "rating" | "title";

/** TMDB sort_by value plus guards so "rating" is not dominated by 10/10 titles with two votes. */
export function tmdbSortParams(sort: GenreSort, media: "movie" | "tv"): string {
  switch (sort) {
    case "release":
      return media === "tv" ? "sort_by=first_air_date.desc&vote_count.gte=20" : "sort_by=primary_release_date.desc&vote_count.gte=20";
    case "rating":
      return "sort_by=vote_average.desc&vote_count.gte=300";
    case "title":
      return media === "tv" ? "sort_by=name.asc&vote_count.gte=50" : "sort_by=title.asc&vote_count.gte=50";
    default:
      return "sort_by=popularity.desc";
  }
}

export function genreHref(genre: GenreDef, media?: "movie" | "tv" | "all"): string {
  const params = new URLSearchParams({ g: genre.slug });
  if (media && media !== "all") params.set("media", media);
  return `/browse/genre?${params}`;
}
