/** Parse season/episode numbers from release names (S01E05, 1x05, etc.). */

export interface ParsedEpisode {
  season: number;
  episode: number;
}

const PATTERNS: RegExp[] = [
  /[.\s_-]s(\d{1,2})e(\d{1,2})\b/i,
  /\b(\d{1,2})x(\d{1,2})\b/i,
  /\bseason[\s._-]*(\d{1,2})[\s._-]*episode[\s._-]*(\d{1,2})\b/i,
  /\bs(\d{1,2})[\s._-]*e(\d{1,2})\b/i,
];

export function parseEpisodeFromText(text: string): ParsedEpisode | null {
  const base = text.replace(/\\/g, "/");
  for (const pattern of PATTERNS) {
    const match = base.match(pattern);
    if (!match) continue;
    const season = parseInt(match[1], 10);
    const episode = parseInt(match[2], 10);
    if (Number.isFinite(season) && Number.isFinite(episode) && season > 0 && episode > 0) {
      return { season, episode };
    }
  }
  return null;
}

export function episodeMatchesPath(
  filePath: string,
  season: number,
  episode: number
): boolean {
  const parsed = parseEpisodeFromText(filePath);
  return parsed?.season === season && parsed?.episode === episode;
}

export function formatEpisodeLabel(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}
