import { describe, expect, it } from "vitest";
import { findGenre, GENRES, genreForTmdbId, genreHref, HOME_GENRE_SLUGS, NAV_GENRE_SLUGS, tmdbSortParams } from "./genres";

describe("genre catalog", () => {
  it("maps every navbar/homepage genre to a TMDB film id (and a TV id where TMDB has one)", () => {
    for (const slug of [...NAV_GENRE_SLUGS, ...HOME_GENRE_SLUGS]) {
      const g = findGenre(slug);
      expect(g, slug).toBeDefined();
      expect(g!.movieId, slug).not.toBeNull();
    }
    expect(findGenre("science-fiction")).toMatchObject({ movieId: 878, tvId: 10765 });
    expect(findGenre("action")).toMatchObject({ movieId: 28, tvId: 10759 });
    expect(findGenre("horror")!.tvId).toBeNull(); // TMDB has no Horror TV genre
  });

  it("accepts legacy names from old links", () => {
    expect(findGenre("Sci-Fi")?.slug).toBe("science-fiction");
    expect(findGenre("Science Fiction")?.slug).toBe("science-fiction");
    expect(findGenre("Action")?.slug).toBe("action");
    expect(findGenre("nonsense")).toBeUndefined();
  });

  it("resolves TMDB ids per media type", () => {
    expect(genreForTmdbId(10759, "tv")?.slug).toBe("action");
    expect(genreForTmdbId(28, "movie")?.slug).toBe("action");
    expect(genreForTmdbId(28, "tv")).toBeUndefined();
  });

  it("guards rating sorts against tiny vote counts and builds hrefs with slugs", () => {
    expect(tmdbSortParams("rating", "movie")).toContain("vote_count.gte=300");
    expect(tmdbSortParams("release", "tv")).toContain("first_air_date.desc");
    expect(genreHref(GENRES[0], "tv")).toBe("/browse/genre?g=action&media=tv");
  });
});
