import { NextRequest, NextResponse } from "next/server";
import {
  getTrending,
  getTrendingTv,
  getPopular,
  getPopularTv,
  getTopRated,
  getTopRatedTv,
  getNowPlaying,
  getOnTheAir,
  getAiringToday,
  searchMovies,
  getMovieDetails,
  getMovieVideos,
  getSimilarMovies,
  getTvDetails,
  getTvVideos,
  getSimilarTv,
  getGenres,
  getMoviesByGenre,
  discoverMoviesByProvider,
  discoverTvByProvider,
  enrichItemsWithWatchProviders,
  discoverByGenre,
  getTrendingToday,
  getUpcoming,
  getDigitalReleases,
  getRecommendations,
  getHeroDetails,
  getTitleDetails,
  getSeasonDetails,
  getBasicTitle,
  searchTv,
} from "@/lib/tmdb";
import { getViewer } from "@/lib/auth";
import { isRestricted, type MaturityLevel } from "@/lib/maturity";
import { RESTRICTED_RESPONSE, filterForMaturity, titleAllowed } from "@/lib/maturity-server";
import { findGenre, type GenreSort } from "@/lib/genres";
import { mergeSettings } from "@/lib/settings";
import type { MediaItem } from "@/lib/types";

async function withWatchProviders(
  items: MediaItem[],
  apiKey: string,
  country: string
): Promise<MediaItem[]> {
  return enrichItemsWithWatchProviders(items, apiKey, country);
}

function resolveApiKey(_request: NextRequest): string | undefined {
  return mergeSettings().tmdbApiKey?.trim() || undefined;
}

export async function GET(request: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const apiKey = resolveApiKey(request);
  if (!apiKey) {
    return NextResponse.json({ error: "TMDB API key not configured" }, { status: 503 });
  }
  const response = await handle(request, apiKey);
  if (!isRestricted(viewer.maturity) || !response.ok) return response;
  return restrict(request, await response.json(), viewer.maturity, apiKey);
}

/**
 * Restricted (kids/teen) profiles: drop titles outside the profile's maturity level from every
 * list, and refuse single-title requests for them. Applied on the server, so a browser cannot opt out.
 */
async function restrict(request: NextRequest, body: Record<string, unknown>, level: MaturityLevel, apiKey: string) {
  const type = request.nextUrl.searchParams.get("type") ?? "trending";
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "", 10);
  const tvTypes = ["tv_details", "tv_videos", "season"];
  const media: "movie" | "tv" =
    tvTypes.includes(type) || request.nextUrl.searchParams.get("media") === "tv" ? "tv" : "movie";
  const single = ["details", "tv_details", "videos", "tv_videos", "hero", "title", "season"];
  if (single.includes(type) && Number.isFinite(id)) {
    const known = (body.item as MediaItem | undefined)?.certification ?? (type === "hero" ? (body.certification as string | undefined) : undefined);
    if (!(await titleAllowed(level, apiKey, id, media, known))) return NextResponse.json(RESTRICTED_RESPONSE, { status: 403 });
  }
  if (Array.isArray(body.items)) body.items = await filterForMaturity(body.items as MediaItem[], level, apiKey);
  if (Array.isArray(body.recommendations)) body.recommendations = await filterForMaturity(body.recommendations as MediaItem[], level, apiKey);
  return NextResponse.json({ ...body, maturity: level });
}

async function handle(request: NextRequest, apiKey: string): Promise<NextResponse> {

  const type = request.nextUrl.searchParams.get("type") ?? "trending";
  const query = request.nextUrl.searchParams.get("q");
  const id = request.nextUrl.searchParams.get("id");
  const genreId = request.nextUrl.searchParams.get("genreId");
  const page = parseInt(request.nextUrl.searchParams.get("page") ?? "1", 10);
  const country = request.nextUrl.searchParams.get("country") ?? "US";

  try {
    if (type === "details" && id) {
      const movie = await getMovieDetails(apiKey, parseInt(id, 10));
      const item: MediaItem = {
        id: `tmdb-${movie.id}`,
        tmdbId: movie.id,
        mediaType: "movie",
        title: movie.title,
        overview: movie.overview,
        posterPath: movie.poster_path ?? undefined,
        backdropPath: movie.backdrop_path ?? undefined,
        releaseDate: movie.release_date,
        rating: movie.vote_average,
        runtime: movie.runtime,
        genres: movie.genres.map((g) => g.name),
        genreIds: movie.genres.map((g) => g.id),
        type: "movie",
        source: "tmdb",
      };
      const [enriched] = await withWatchProviders([item], apiKey, country);
      return NextResponse.json({ item: enriched });
    }

    if (type === "tv_details" && id) {
      const show = await getTvDetails(apiKey, parseInt(id, 10));
      const item: MediaItem = {
        id: `tmdb-tv-${show.id}`,
        tmdbId: show.id,
        mediaType: "tv",
        title: show.name,
        overview: show.overview,
        posterPath: show.poster_path ?? undefined,
        backdropPath: show.backdrop_path ?? undefined,
        releaseDate: show.first_air_date,
        rating: show.vote_average,
        genres: show.genres.map((g) => g.name),
        genreIds: show.genres.map((g) => g.id),
        type: "series",
        source: "tmdb",
      };
      const [enriched] = await withWatchProviders([item], apiKey, country);
      return NextResponse.json({ item: enriched });
    }

    if (type === "videos" && id) {
      const key = await getMovieVideos(apiKey, parseInt(id, 10));
      return NextResponse.json({ key });
    }

    if (type === "tv_videos" && id) {
      const key = await getTvVideos(apiKey, parseInt(id, 10));
      return NextResponse.json({ key });
    }

    if (type === "similar" && id) {
      const items = await getSimilarMovies(apiKey, parseInt(id, 10));
      return NextResponse.json({
        items: await withWatchProviders(items, apiKey, country),
      });
    }

    if (type === "tv_similar" && id) {
      const items = await getSimilarTv(apiKey, parseInt(id, 10));
      return NextResponse.json({
        items: await withWatchProviders(items, apiKey, country),
      });
    }

    if (type === "genres") {
      const genres = await getGenres(apiKey);
      return NextResponse.json({ genres });
    }

    // Genre browsing: ?type=genre&g=<slug>&media=movie|tv|all&sort=popularity|release|rating|title&page=N
    // (legacy ?genreId=<tmdb movie id> still works).
    if (type === "genre") {
      const slugParam = request.nextUrl.searchParams.get("g");
      const genre = findGenre(slugParam) ?? findGenre(request.nextUrl.searchParams.get("name"));
      const legacyId = genreId ? parseInt(genreId, 10) : NaN;
      const mediaParam = request.nextUrl.searchParams.get("media");
      const sortParam = request.nextUrl.searchParams.get("sort") as GenreSort | null;
      const sort: GenreSort = sortParam && ["popularity", "release", "rating", "title"].includes(sortParam) ? sortParam : "popularity";
      const movieId = genre?.movieId ?? (Number.isFinite(legacyId) ? legacyId : null);
      const tvId = genre?.tvId ?? null;
      if (movieId == null && tvId == null) {
        return NextResponse.json({ error: "Unknown genre" }, { status: 404 });
      }
      const wantMovies = mediaParam !== "tv" && movieId != null;
      const wantTv = (mediaParam === "tv" || mediaParam === "all" || !mediaParam) && tvId != null;
      const [movies, tv] = await Promise.all([
        wantMovies ? discoverByGenre(apiKey, "movie", movieId!, page, sort, country) : null,
        wantTv ? discoverByGenre(apiKey, "tv", tvId!, page, sort, country) : null,
      ]);
      // "all": interleave films and shows so neither dominates the grid.
      const items: MediaItem[] = [];
      const a = movies?.items ?? [];
      const b = tv?.items ?? [];
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i]) items.push(a[i]);
        if (b[i]) items.push(b[i]);
      }
      return NextResponse.json({
        genre: genre ? { slug: genre.slug, name: genre.name, hasTv: genre.tvId != null, hasMovies: genre.movieId != null } : null,
        media: mediaParam === "tv" ? "tv" : mediaParam === "all" || (!mediaParam && wantTv) ? "all" : "movie",
        sort,
        page,
        items: await withWatchProviders(items, apiKey, country),
        totalPages: Math.max(movies?.totalPages ?? 0, tv?.totalPages ?? 0),
        totalResults: (movies?.totalResults ?? 0) + (tv?.totalResults ?? 0),
      });
    }

    if (type === "discover_provider") {
      const providerId = parseInt(
        request.nextUrl.searchParams.get("providerId") ?? "",
        10
      );
      const media = request.nextUrl.searchParams.get("media") ?? "movie";
      if (!Number.isFinite(providerId)) {
        return NextResponse.json({ error: "providerId required" }, { status: 400 });
      }
      const items =
        media === "tv"
          ? await discoverTvByProvider(apiKey, providerId, page, country)
          : await discoverMoviesByProvider(apiKey, providerId, page, country);
      return NextResponse.json({
        items: await withWatchProviders(items, apiKey, country),
      });
    }

    // Details view: ?type=title&id=<tmdb id>&media=movie|tv
    if (type === "title" && id) {
      const media = request.nextUrl.searchParams.get("media") === "tv" ? "tv" : "movie";
      const details = await getTitleDetails(apiKey, parseInt(id, 10), media, country);
      const [item] = await withWatchProviders([details.item], apiKey, country);
      return NextResponse.json({ ...details, item });
    }

    // Episodes of one season: ?type=season&id=<tmdb tv id>&season=N
    if (type === "season" && id) {
      const season = parseInt(request.nextUrl.searchParams.get("season") ?? "1", 10);
      if (!Number.isFinite(season) || season < 0) return NextResponse.json({ error: "Invalid season" }, { status: 400 });
      return NextResponse.json(await getSeasonDetails(apiKey, parseInt(id, 10), season));
    }

    // Saved titles by id: ?type=lookup&ids=tmdb-1,tmdb-tv-2 (at most 60; unknown ids are skipped).
    if (type === "lookup") {
      const ids = (request.nextUrl.searchParams.get("ids") ?? "").split(",").filter((x) => /^tmdb-(tv-)?\d+$/.test(x)).slice(0, 60);
      const items = (
        await Promise.all(
          ids.map((x) => {
            const tv = x.startsWith("tmdb-tv-");
            return getBasicTitle(apiKey, parseInt(x.replace(/^tmdb-(tv-)?/, ""), 10), tv ? "tv" : "movie").catch(() => null);
          })
        )
      ).filter((x): x is MediaItem => x !== null);
      return NextResponse.json({ items });
    }

    if (type === "hero" && id) {
      const media = request.nextUrl.searchParams.get("media") === "tv" ? "tv" : "movie";
      return NextResponse.json(await getHeroDetails(apiKey, parseInt(id, 10), media, country));
    }

    if (type === "recommendations" && id) {
      const media = request.nextUrl.searchParams.get("media") === "tv" ? "tv" : "movie";
      const items = await getRecommendations(apiKey, parseInt(id, 10), media);
      return NextResponse.json({ items: await withWatchProviders(items, apiKey, country) });
    }

    let items: MediaItem[];
    switch (type) {
      case "trending_day":
        items = await getTrendingToday(apiKey, page);
        break;
      case "upcoming":
        items = await getUpcoming(apiKey, page, country);
        break;
      case "digital":
        items = await getDigitalReleases(apiKey, page, country);
        break;
      case "popular":
        items = await getPopular(apiKey, page);
        break;
      case "popular_tv":
        items = await getPopularTv(apiKey, page);
        break;
      case "top_rated":
        items = await getTopRated(apiKey, page);
        break;
      case "top_rated_tv":
        items = await getTopRatedTv(apiKey, page);
        break;
      case "now_playing":
        items = await getNowPlaying(apiKey, page);
        break;
      case "trending_tv":
        items = await getTrendingTv(apiKey, page);
        break;
      case "on_the_air":
        items = await getOnTheAir(apiKey, page);
        break;
      case "airing_today":
        items = await getAiringToday(apiKey, page);
        break;
      case "search":
        if (!query) return NextResponse.json({ items: [] });
        {
          // Films and shows, interleaved by TMDB relevance.
          const [movies, shows] = await Promise.all([searchMovies(apiKey, query), searchTv(apiKey, query).catch(() => [])]);
          items = [];
          for (let i = 0; i < Math.max(movies.length, shows.length); i++) {
            if (movies[i]) items.push(movies[i]);
            if (shows[i]) items.push(shows[i]);
          }
        }
        break;
      default:
        items = await getTrending(apiKey, page);
    }
    return NextResponse.json({
      items: await withWatchProviders(items, apiKey, country),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "TMDB error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
