"use client";

import { useEffect, useState } from "react";
import { Play, Library } from "lucide-react";
import { MediaImage } from "@/components/ui/MediaImage";
import { cn } from "@/lib/cn";
import type { EpisodeListEntry, SeasonGroup } from "@/lib/episode-library";
import { formatEpisodeLabel } from "@/lib/episode-parse";
import { getLastWatched } from "@/lib/store";

interface EpisodeBrowserProps {
  title: string;
  poster?: string;
  tmdbId?: number;
  seriesId?: string;
  currentSeason?: number;
  currentEpisode?: number;
  onSelect: (season: number, episode: number, watchId?: string) => void;
  layout?: "fullscreen" | "embedded";
  className?: string;
}

export function EpisodeBrowser({
  title,
  poster,
  tmdbId,
  seriesId,
  currentSeason,
  currentEpisode,
  onSelect,
  layout = "fullscreen",
  className,
}: EpisodeBrowserProps) {
  const [seasons, setSeasons] = useState<SeasonGroup[]>([]);
  const [activeSeason, setActiveSeason] = useState<number | null>(null);
  const [focusedEpisode, setFocusedEpisode] = useState<EpisodeListEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      const params = new URLSearchParams();
      if (tmdbId) params.set("tmdbId", String(tmdbId));
      if (seriesId) params.set("seriesId", seriesId);
      params.set("title", title);

      const res = await fetch(`/api/play/episodes?${params}`).catch(() => null);
      if (cancelled) return;

      if (!res?.ok) {
        const data = await res?.json().catch(() => ({}));
        setError(data.message || data.error || "Could not load episodes");
        setLoading(false);
        return;
      }

      const data = await res.json();
      const list = (data.seasons ?? []) as SeasonGroup[];
      setSeasons(list);

      const lastWatched =
        seriesId && currentSeason == null ? getLastWatched(seriesId) : null;
      const resumeSeason = currentSeason ?? lastWatched?.season;
      const resumeEpisode = currentEpisode ?? lastWatched?.episode;

      const initialSeason =
        resumeSeason != null && list.some((s) => s.season === resumeSeason)
          ? resumeSeason
          : (list[0]?.season ?? null);
      setActiveSeason(initialSeason);

      if (resumeSeason != null && resumeEpisode != null) {
        const ep = list
          .find((s) => s.season === resumeSeason)
          ?.episodes.find((e) => e.episode === resumeEpisode);
        setFocusedEpisode(ep ?? list[0]?.episodes[0] ?? null);
      } else {
        setFocusedEpisode(list[0]?.episodes[0] ?? null);
      }

      setLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [title, tmdbId, seriesId, currentSeason, currentEpisode]);

  const active = seasons.find((s) => s.season === activeSeason);
  const isEmbedded = layout === "embedded";

  if (loading) {
    return (
      <div className={cn("flex items-center justify-center py-12", className)}>
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("px-4 py-8 text-center text-red-400", className)}>
        <p>{error}</p>
      </div>
    );
  }

  if (seasons.length === 0) {
    return (
      <div className={cn("px-4 py-8 text-center text-netflix-light-gray", className)}>
        <p>No episodes found. Sync your library or add a TMDB API key.</p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden",
        isEmbedded ? "rounded-lg border border-white/10 bg-black/40" : "flex-1",
        className
      )}
    >
      {!isEmbedded && poster && (
        <div className="hidden border-b border-white/10 px-6 py-3 md:flex md:items-center md:gap-3">
          <div className="relative h-12 w-8 overflow-hidden rounded">
            <MediaImage src={poster} alt="" fill className="object-cover" sizes="32px" />
          </div>
          <p className="text-sm text-netflix-light-gray">{title}</p>
        </div>
      )}

      <div className={cn("flex flex-1 flex-col overflow-hidden", !isEmbedded && "md:flex-row")}>
        <div
          className={cn(
            "flex gap-2 overflow-x-auto border-white/10 px-4 py-3",
            isEmbedded ? "border-b" : "border-b md:w-52 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r"
          )}
        >
          {seasons.map((group) => (
            <button
              key={group.season}
              type="button"
              onClick={() => {
                setActiveSeason(group.season);
                const first = group.episodes[0];
                if (first) setFocusedEpisode(first);
              }}
              className={cn(
                "shrink-0 rounded px-4 py-2 text-left text-sm transition",
                isEmbedded ? "md:w-auto" : "md:w-full",
                activeSeason === group.season
                  ? "bg-white text-black"
                  : "bg-white/10 hover:bg-white/20"
              )}
            >
              Season {group.season}
              <span className="ml-2 text-xs opacity-70">{group.episodes.length}</span>
            </button>
          ))}
        </div>

        <div className={cn("flex flex-1 flex-col overflow-hidden", !isEmbedded && "md:flex-row")}>
          <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6">
            <div className="mx-auto flex max-w-3xl flex-col gap-2">
              {active?.episodes.map((ep) => {
                const isCurrent =
                  currentSeason === ep.season && currentEpisode === ep.episode;
                const isFocused =
                  focusedEpisode?.season === ep.season &&
                  focusedEpisode?.episode === ep.episode;

                return (
                  <button
                    key={`${ep.season}-${ep.episode}`}
                    type="button"
                    onMouseEnter={() => setFocusedEpisode(ep)}
                    onFocus={() => setFocusedEpisode(ep)}
                    onClick={() =>
                      onSelect(
                        ep.season,
                        ep.episode,
                        ep.inLibrary ? ep.watchId : undefined
                      )
                    }
                    className={cn(
                      "group flex w-full items-start gap-4 rounded-lg border px-4 py-3 text-left transition",
                      isCurrent
                        ? "border-netflix-red bg-netflix-red/10"
                        : isFocused
                          ? "border-white/30 bg-white/10"
                          : "border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10"
                    )}
                  >
                    <div className="relative mt-0.5 flex h-16 w-28 shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-800">
                      {ep.stillPath ? (
                        <MediaImage
                          src={ep.stillPath}
                          alt=""
                          fill
                          className="object-cover"
                          sizes="112px"
                        />
                      ) : (
                        <span className="text-xs text-netflix-gray">
                          {formatEpisodeLabel(ep.season, ep.episode)}
                        </span>
                      )}
                      <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition group-hover:opacity-100">
                        <Play className="h-6 w-6 fill-current" />
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {formatEpisodeLabel(ep.season, ep.episode)} · {ep.title}
                        </span>
                        {ep.inLibrary && (
                          <span className="flex items-center gap-1 rounded bg-green-900/40 px-2 py-0.5 text-xs text-green-300">
                            <Library className="h-3 w-3" />
                            In library
                          </span>
                        )}
                        {isCurrent && (
                          <span className="rounded bg-netflix-red/20 px-2 py-0.5 text-xs text-netflix-red">
                            Now playing
                          </span>
                        )}
                      </div>
                      {ep.overview && (
                        <p
                          className={cn(
                            "text-sm text-netflix-light-gray",
                            isEmbedded ? "line-clamp-2" : "line-clamp-3"
                          )}
                        >
                          {ep.overview}
                        </p>
                      )}
                      {(ep.runtime || ep.airDate) && (
                        <p className="mt-1 text-xs text-netflix-gray">
                          {ep.runtime ? `${ep.runtime}m` : ""}
                          {ep.runtime && ep.airDate ? " · " : ""}
                          {ep.airDate ? ep.airDate.slice(0, 10) : ""}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {!isEmbedded && focusedEpisode && (
            <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-white/10 bg-black/40 p-6 lg:block">
              <p className="mb-1 text-xs uppercase tracking-wide text-netflix-gray">
                {formatEpisodeLabel(focusedEpisode.season, focusedEpisode.episode)}
              </p>
              <h3 className="mb-3 text-lg font-semibold">{focusedEpisode.title}</h3>
              {focusedEpisode.stillPath && (
                <div className="relative mb-4 aspect-video w-full overflow-hidden rounded-lg bg-zinc-800">
                  <MediaImage
                    src={focusedEpisode.stillPath}
                    alt=""
                    fill
                    className="object-cover"
                    sizes="320px"
                  />
                </div>
              )}
              {focusedEpisode.overview ? (
                <p className="text-sm leading-relaxed text-netflix-light-gray">
                  {focusedEpisode.overview}
                </p>
              ) : (
                <p className="text-sm text-netflix-gray">No synopsis available.</p>
              )}
              <button
                type="button"
                onClick={() => onSelect(focusedEpisode.season, focusedEpisode.episode)}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded bg-white py-2.5 font-semibold text-black hover:bg-white/90"
              >
                <Play className="h-5 w-5 fill-current" />
                Play episode
              </button>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
