import { NextRequest, NextResponse } from "next/server";
import type { SeasonGroup } from "@/lib/episode-library";
import { getTvDetails, getTvSeasonEpisodes, posterUrl } from "@/lib/tmdb";
import { mergeSettingsForServerOps } from "@/lib/settings";

async function loadTmdbSeasons(apiKey: string, tmdbId: number, seasonNumbers: number[]): Promise<SeasonGroup[]> {
  const groups: SeasonGroup[] = [];
  for (const season of seasonNumbers) {
    try {
      const data = await getTvSeasonEpisodes(apiKey, tmdbId, season);
      const episodes = data.episodes.map((ep) => ({
        season: ep.season_number,
        episode: ep.episode_number,
        title: ep.name || `Episode ${ep.episode_number}`,
        overview: ep.overview,
        stillPath: ep.still_path ? posterUrl(ep.still_path, "w500") : undefined,
        runtime: ep.runtime ?? undefined,
        airDate: ep.air_date,
        inLibrary: false,
      }));
      if (episodes.length > 0) groups.push({ season, episodes });
    } catch {
      /* skip missing seasons */
    }
  }
  return groups;
}

/** Seasons and episodes of a series, from TMDB. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tmdbId = parseInt(params.get("tmdbId") ?? "", 10);
  const title = params.get("title") ?? undefined;
  const apiKey = mergeSettingsForServerOps().tmdbApiKey;

  if (!apiKey) {
    return NextResponse.json({ seasons: [], message: "The server owner needs to add a TMDB key in Settings for episode lists." });
  }
  if (!Number.isFinite(tmdbId)) {
    return NextResponse.json({ seasons: [], message: "This show has no TMDB id, so its episodes can't be listed." });
  }

  let seasons: SeasonGroup[] = [];
  try {
    const tvShow = await getTvDetails(apiKey, tmdbId);
    const seasonNumbers = tvShow.seasons.map((s) => s.season_number).filter((n) => n > 0).sort((a, b) => a - b);
    seasons = await loadTmdbSeasons(apiKey, tmdbId, seasonNumbers);
  } catch (err) {
    console.warn("[play/episodes] TMDB load failed:", err instanceof Error ? err.message : err);
  }

  if (seasons.length === 0) {
    return NextResponse.json({ seasons: [], message: "No episodes found for this show on TMDB." });
  }
  return NextResponse.json({ seasons, showTitle: title, tmdbId });
}
