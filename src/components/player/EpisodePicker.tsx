"use client";

import { ArrowLeft } from "lucide-react";
import { MediaImage } from "@/components/ui/MediaImage";
import { EpisodeBrowser } from "./EpisodeBrowser";

interface EpisodePickerProps {
  title: string;
  poster?: string;
  tmdbId?: number;
  seriesId?: string;
  currentSeason?: number;
  currentEpisode?: number;
  onSelect: (season: number, episode: number, watchId?: string) => void;
  onCancel: () => void;
  overlay?: boolean;
}

export function EpisodePicker({
  title,
  poster,
  tmdbId,
  seriesId,
  currentSeason,
  currentEpisode,
  onSelect,
  onCancel,
  overlay,
}: EpisodePickerProps) {
  return (
    <div
      className={
        overlay
          ? "fixed inset-0 z-[60] flex flex-col bg-black/95 backdrop-blur-sm"
          : "fixed inset-0 z-50 flex flex-col bg-black"
      }
    >
      <div className="flex items-center gap-4 border-b border-white/10 px-4 py-4 md:px-8">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full p-2 hover:bg-white/10"
          aria-label="Go back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-4">
          {poster && (
            <div className="relative hidden h-14 w-10 shrink-0 overflow-hidden rounded sm:block">
              <MediaImage src={poster} alt="" fill className="object-cover" sizes="40px" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold md:text-xl">{title}</h1>
            <p className="text-sm text-netflix-light-gray">Choose a season and episode</p>
          </div>
        </div>
      </div>

      <EpisodeBrowser
        title={title}
        poster={poster}
        tmdbId={tmdbId}
        seriesId={seriesId}
        currentSeason={currentSeason}
        currentEpisode={currentEpisode}
        onSelect={onSelect}
        layout="fullscreen"
        className="flex-1"
      />
    </div>
  );
}
