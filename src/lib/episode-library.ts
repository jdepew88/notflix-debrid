import type { MediaItem } from "./types";

export interface EpisodeListEntry {
  season: number;
  episode: number;
  title: string;
  overview?: string;
  stillPath?: string;
  runtime?: number;
  airDate?: string;
  watchId?: string;
  libraryItem?: MediaItem;
  inLibrary: boolean;
}

export interface SeasonGroup {
  season: number;
  episodes: EpisodeListEntry[];
}
